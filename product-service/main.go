package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

type Product struct {
	ID          primitive.ObjectID `json:"id" bson:"_id,omitempty"`
	Name        string             `json:"name" bson:"name"`
	Description string             `json:"description" bson:"description"`
	Category    string             `json:"category" bson:"category"`
	Emoji       string             `json:"emoji" bson:"emoji"`
	Price       float64            `json:"price" bson:"price"`
	Stock       int                `json:"stock" bson:"stock"`
	CreatedAt   time.Time          `json:"createdAt" bson:"createdAt"`
}

type listResp struct {
	Items []Product `json:"items"`
	Total int64     `json:"total"`
	Page  int       `json:"page"`
	Pages int       `json:"pages"`
}

var (
	mongoClient   *mongo.Client
	col           *mongo.Collection
	rdb           *redis.Client
	internalToken string
	hostname      string
)

/* ------------------------------ helpers ------------------------------ */

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func atoi(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

func parseID(w http.ResponseWriter, r *http.Request) (primitive.ObjectID, bool) {
	oid, err := primitive.ObjectIDFromHex(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid product id")
		return oid, false
	}
	return oid, true
}

func admin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-User-Role") != "admin" {
			writeErr(w, http.StatusForbidden, "admin access required")
			return
		}
		h(w, r)
	}
}

func internalOK(r *http.Request) bool {
	got := r.Header.Get("X-Internal-Token")
	return internalToken != "" && subtle.ConstantTimeCompare([]byte(got), []byte(internalToken)) == 1
}

/* ------------------------------ cache ------------------------------ */

func cacheGet(ctx context.Context, key string) ([]byte, bool) {
	b, err := rdb.Get(ctx, key).Bytes()
	return b, err == nil
}

func cacheSet(ctx context.Context, key string, b []byte) {
	_ = rdb.Set(ctx, key, b, 30*time.Second).Err()
}

func cacheVersion(ctx context.Context) string {
	v, err := rdb.Get(ctx, "products:ver").Result()
	if err != nil {
		return "0"
	}
	return v
}

func invalidate() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = rdb.Incr(ctx, "products:ver").Err()
}

func serveCached(w http.ResponseWriter, b []byte, hit bool) {
	w.Header().Set("Content-Type", "application/json")
	if hit {
		w.Header().Set("X-Cache", "HIT")
	} else {
		w.Header().Set("X-Cache", "MISS")
	}
	_, _ = w.Write(b)
}

/* ------------------------------ handlers ------------------------------ */

func listProducts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	key := "products:list:" + cacheVersion(ctx) + ":" + q.Encode()
	if b, ok := cacheGet(ctx, key); ok {
		serveCached(w, b, true)
		return
	}

	filter := bson.M{}
	if s := strings.TrimSpace(q.Get("search")); s != "" {
		filter["name"] = bson.M{"$regex": regexp.QuoteMeta(s), "$options": "i"}
	}
	if c := q.Get("category"); c != "" && c != "all" {
		filter["category"] = c
	}
	sortSpec := bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: 1}}
	switch q.Get("sort") {
	case "price_asc":
		sortSpec = bson.D{{Key: "price", Value: 1}, {Key: "_id", Value: 1}}
	case "price_desc":
		sortSpec = bson.D{{Key: "price", Value: -1}, {Key: "_id", Value: 1}}
	case "name":
		sortSpec = bson.D{{Key: "name", Value: 1}, {Key: "_id", Value: 1}}
	}
	page := max(atoi(q.Get("page"), 1), 1)
	limit := min(max(atoi(q.Get("limit"), 12), 1), 50)

	total, err := col.CountDocuments(ctx, filter)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	opts := options.Find().SetSort(sortSpec).SetSkip(int64((page - 1) * limit)).SetLimit(int64(limit))
	cur, err := col.Find(ctx, filter, opts)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	items := []Product{}
	if err := cur.All(ctx, &items); err != nil {
		writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	pages := int((total + int64(limit) - 1) / int64(limit))
	if pages < 1 {
		pages = 1
	}
	b, _ := json.Marshal(listResp{Items: items, Total: total, Page: page, Pages: pages})
	cacheSet(ctx, key, b)
	serveCached(w, b, false)
}

func listCategories(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := "products:cats:" + cacheVersion(ctx)
	if b, ok := cacheGet(ctx, key); ok {
		serveCached(w, b, true)
		return
	}
	vals, err := col.Distinct(ctx, "category", bson.M{})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	cats := []string{}
	for _, v := range vals {
		if s, ok := v.(string); ok && s != "" {
			cats = append(cats, s)
		}
	}
	sort.Strings(cats)
	b, _ := json.Marshal(cats)
	cacheSet(ctx, key, b)
	serveCached(w, b, false)
}

func productStats(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-User-Role") != "admin" {
		writeErr(w, http.StatusForbidden, "admin access required")
		return
	}
	ctx := r.Context()
	total, _ := col.CountDocuments(ctx, bson.M{})
	low, _ := col.CountDocuments(ctx, bson.M{"stock": bson.M{"$gt": 0, "$lte": 5}})
	out, _ := col.CountDocuments(ctx, bson.M{"stock": 0})
	value := 0.0
	pipe := mongo.Pipeline{bson.D{{Key: "$group", Value: bson.D{
		{Key: "_id", Value: nil},
		{Key: "value", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$multiply", Value: bson.A{"$price", "$stock"}}}}}},
	}}}}
	if cur, err := col.Aggregate(ctx, pipe); err == nil {
		var res []struct {
			Value float64 `bson:"value"`
		}
		if cur.All(ctx, &res) == nil && len(res) > 0 {
			value = res[0].Value
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"total": total, "lowStock": low, "outOfStock": out, "inventoryValue": value})
}

func getProduct(w http.ResponseWriter, r *http.Request) {
	oid, ok := parseID(w, r)
	if !ok {
		return
	}
	var p Product
	err := col.FindOne(r.Context(), bson.M{"_id": oid}).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		writeErr(w, http.StatusNotFound, "product not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type productInput struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Category    string  `json:"category"`
	Emoji       string  `json:"emoji"`
	Price       float64 `json:"price"`
	Stock       int     `json:"stock"`
}

func (in *productInput) clean() error {
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	in.Category = strings.TrimSpace(in.Category)
	in.Emoji = strings.TrimSpace(in.Emoji)
	if in.Name == "" || len([]rune(in.Name)) > 120 {
		return errors.New("name is required (max 120 characters)")
	}
	if len([]rune(in.Description)) > 500 {
		return errors.New("description is too long (max 500 characters)")
	}
	if in.Price < 0 || in.Price > 10_000_000 {
		return errors.New("price must be between 0 and 10,000,000")
	}
	if in.Stock < 0 || in.Stock > 1_000_000 {
		return errors.New("stock must be between 0 and 1,000,000")
	}
	if in.Category == "" {
		in.Category = "General"
	}
	if in.Emoji == "" {
		in.Emoji = "📦"
	}
	return nil
}

func createProduct(w http.ResponseWriter, r *http.Request) {
	var in productInput
	if !decode(w, r, &in) {
		return
	}
	if err := in.clean(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	p := Product{ID: primitive.NewObjectID(), Name: in.Name, Description: in.Description, Category: in.Category,
		Emoji: in.Emoji, Price: in.Price, Stock: in.Stock, CreatedAt: time.Now().UTC()}
	if _, err := col.InsertOne(r.Context(), p); err != nil {
		writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	invalidate()
	writeJSON(w, http.StatusCreated, p)
}

func updateProduct(w http.ResponseWriter, r *http.Request) {
	oid, ok := parseID(w, r)
	if !ok {
		return
	}
	var in productInput
	if !decode(w, r, &in) {
		return
	}
	if err := in.clean(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	upd := bson.M{"$set": bson.M{"name": in.Name, "description": in.Description, "category": in.Category,
		"emoji": in.Emoji, "price": in.Price, "stock": in.Stock}}
	var p Product
	err := col.FindOneAndUpdate(r.Context(), bson.M{"_id": oid}, upd,
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		writeErr(w, http.StatusNotFound, "product not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	invalidate()
	writeJSON(w, http.StatusOK, p)
}

func deleteProduct(w http.ResponseWriter, r *http.Request) {
	oid, ok := parseID(w, r)
	if !ok {
		return
	}
	res, err := col.DeleteOne(r.Context(), bson.M{"_id": oid})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	if res.DeletedCount == 0 {
		writeErr(w, http.StatusNotFound, "product not found")
		return
	}
	invalidate()
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

/* ------------------------------ internal: stock ------------------------------ */

type stockItem struct {
	ProductID string `json:"product_id"`
	Quantity  int    `json:"quantity"`
}

type reservedItem struct {
	ProductID string  `json:"product_id"`
	Name      string  `json:"name"`
	Emoji     string  `json:"emoji"`
	Price     float64 `json:"price"`
	Quantity  int     `json:"quantity"`
}

func addStock(items []stockItem) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, it := range items {
		oid, err := primitive.ObjectIDFromHex(it.ProductID)
		if err != nil || it.Quantity < 1 {
			continue
		}
		if _, err := col.UpdateOne(ctx, bson.M{"_id": oid}, bson.M{"$inc": bson.M{"stock": it.Quantity}}); err != nil {
			slog.Error("failed to restore stock", "product", it.ProductID, "err", err.Error())
		}
	}
}

// reserve atomically decrements stock for every item, or none of them.
func reserve(w http.ResponseWriter, r *http.Request) {
	if !internalOK(r) {
		writeErr(w, http.StatusForbidden, "internal endpoint")
		return
	}
	var body struct {
		Items []stockItem `json:"items"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Items) == 0 {
		writeErr(w, http.StatusBadRequest, "no items")
		return
	}
	ctx := r.Context()
	done := []stockItem{}
	out := []reservedItem{}
	for _, it := range body.Items {
		oid, err := primitive.ObjectIDFromHex(it.ProductID)
		if err != nil || it.Quantity < 1 {
			addStock(done)
			writeErr(w, http.StatusBadRequest, "invalid item")
			return
		}
		var p Product
		err = col.FindOneAndUpdate(ctx,
			bson.M{"_id": oid, "stock": bson.M{"$gte": it.Quantity}},
			bson.M{"$inc": bson.M{"stock": -it.Quantity}},
			options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&p)
		if errors.Is(err, mongo.ErrNoDocuments) {
			addStock(done)
			n, _ := col.CountDocuments(ctx, bson.M{"_id": oid})
			if n == 0 {
				writeErr(w, http.StatusNotFound, "a product in your cart no longer exists")
			} else {
				var cur Product
				_ = col.FindOne(ctx, bson.M{"_id": oid}).Decode(&cur)
				writeErr(w, http.StatusConflict, fmt.Sprintf("not enough stock for %s (only %d left)", cur.Name, cur.Stock))
			}
			return
		}
		if err != nil {
			addStock(done)
			writeErr(w, http.StatusInternalServerError, "database error")
			return
		}
		done = append(done, it)
		out = append(out, reservedItem{ProductID: it.ProductID, Name: p.Name, Emoji: p.Emoji, Price: p.Price, Quantity: it.Quantity})
	}
	invalidate()
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func release(w http.ResponseWriter, r *http.Request) {
	if !internalOK(r) {
		writeErr(w, http.StatusForbidden, "internal endpoint")
		return
	}
	var body struct {
		Items []stockItem `json:"items"`
	}
	if !decode(w, r, &body) {
		return
	}
	addStock(body.Items)
	invalidate()
	writeJSON(w, http.StatusOK, map[string]int{"released": len(body.Items)})
}

/* ------------------------------ probes ------------------------------ */

func ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	deps := map[string]string{}
	code := http.StatusOK
	if err := mongoClient.Ping(ctx, nil); err != nil {
		deps["mongodb"] = "down"
		code = http.StatusServiceUnavailable
	} else {
		deps["mongodb"] = "up"
	}
	if err := rdb.Ping(ctx).Err(); err != nil {
		deps["redis"] = "down (cache bypassed)"
	} else {
		deps["redis"] = "up"
	}
	status := "ok"
	if code != http.StatusOK {
		status = "down"
	}
	writeJSON(w, code, map[string]any{"status": status, "host": hostname, "deps": deps})
}

/* ------------------------------ middleware ------------------------------ */

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (s *statusWriter) WriteHeader(c int) {
	s.code = c
	s.ResponseWriter.WriteHeader(c)
}

func wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: http.StatusOK}
		sw.Header().Set("X-Served-By", hostname)
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic", "err", fmt.Sprint(rec))
				writeErr(sw, http.StatusInternalServerError, "internal error")
			}
			if r.URL.Path != "/health" && r.URL.Path != "/ready" {
				slog.Info("req", "method", r.Method, "path", r.URL.Path, "status", sw.code,
					"ms", time.Since(start).Milliseconds(), "id", r.Header.Get("X-Request-Id"))
			}
		}()
		next.ServeHTTP(sw, r)
	})
}

/* ------------------------------ seed data ------------------------------ */

var seedData = []Product{
	{Name: "Wireless Headphones", Description: "Over-ear Bluetooth headphones with active noise cancelling and 30-hour battery.", Category: "Electronics", Emoji: "🎧", Price: 4999, Stock: 25},
	{Name: "Smart Watch", Description: "Fitness tracking, heart-rate monitor, GPS and a bright AMOLED display.", Category: "Electronics", Emoji: "⌚", Price: 7999, Stock: 18},
	{Name: "Mechanical Keyboard", Description: "Hot-swappable switches, RGB backlight and a compact 75% layout.", Category: "Electronics", Emoji: "⌨️", Price: 3499, Stock: 40},
	{Name: "Ceramic Coffee Mug", Description: "Handmade 350 ml mug that keeps your drink warm longer.", Category: "Home", Emoji: "☕", Price: 499, Stock: 120},
	{Name: "Scented Candle Set", Description: "Three soy-wax candles: lavender, vanilla and sandalwood.", Category: "Home", Emoji: "🕯️", Price: 899, Stock: 60},
	{Name: "Indoor Plant Pot", Description: "Minimal matte planter with drainage tray, ideal for succulents.", Category: "Home", Emoji: "🪴", Price: 649, Stock: 4},
	{Name: "Classic Denim Jacket", Description: "Relaxed fit, durable cotton denim with brass buttons.", Category: "Fashion", Emoji: "🧥", Price: 2799, Stock: 22},
	{Name: "Running Sneakers", Description: "Lightweight breathable sneakers with responsive cushioning.", Category: "Fashion", Emoji: "👟", Price: 3999, Stock: 35},
	{Name: "Leather Backpack", Description: "Water-resistant 20 L backpack with padded laptop sleeve.", Category: "Fashion", Emoji: "🎒", Price: 2499, Stock: 3},
	{Name: "Cloud Computing Handbook", Description: "A practical guide to containers, Kubernetes and DevOps pipelines.", Category: "Books", Emoji: "📘", Price: 799, Stock: 50},
	{Name: "Yoga Mat", Description: "6 mm non-slip eco-friendly mat with carrying strap.", Category: "Sports", Emoji: "🧘", Price: 1199, Stock: 45},
	{Name: "Insulated Water Bottle", Description: "Stainless steel 1 L bottle, cold for 24 h and hot for 12 h.", Category: "Sports", Emoji: "🍶", Price: 699, Stock: 0},
}

func seedIfEmpty(ctx context.Context) {
	n, err := col.CountDocuments(ctx, bson.M{})
	if err != nil || n > 0 {
		return
	}
	now := time.Now().UTC()
	docs := make([]any, 0, len(seedData))
	for i, s := range seedData {
		// fixed ids make seeding idempotent when several replicas start together
		oid, _ := primitive.ObjectIDFromHex(fmt.Sprintf("5eed%020x", i+1))
		s.ID = oid
		s.CreatedAt = now.Add(-time.Duration(i) * time.Minute)
		docs = append(docs, s)
	}
	if _, err := col.InsertMany(ctx, docs, options.InsertMany().SetOrdered(false)); err != nil {
		slog.Info("seed insert finished (another replica may have seeded)", "note", err.Error())
		return
	}
	slog.Info("seeded products", "count", len(docs))
}

/* ------------------------------ main ------------------------------ */

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil).WithAttrs([]slog.Attr{slog.String("svc", "product-service")})))
	hostname, _ = os.Hostname()
	internalToken = env("INTERNAL_TOKEN", "")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	uri := env("MONGO_URI", "mongodb://mongo:27017")
	var err error
	for i := 1; i <= 40; i++ {
		mongoClient, err = mongo.Connect(ctx, options.Client().ApplyURI(uri).SetServerSelectionTimeout(3*time.Second))
		if err == nil {
			pctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			err = mongoClient.Ping(pctx, nil)
			cancel()
			if err == nil {
				break
			}
			_ = mongoClient.Disconnect(ctx)
		}
		slog.Warn("waiting for mongodb", "attempt", i, "err", err.Error())
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
	if err != nil {
		slog.Error("mongodb unavailable", "err", err.Error())
		os.Exit(1)
	}
	col = mongoClient.Database("productsdb").Collection("products")
	_, _ = col.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "category", Value: 1}}},
		{Keys: bson.D{{Key: "createdAt", Value: -1}}},
	})
	seedIfEmpty(ctx)

	rdb = redis.NewClient(&redis.Options{
		Addr: env("REDIS_ADDR", "redis:6379"), DialTimeout: 500 * time.Millisecond,
		ReadTimeout: 300 * time.Millisecond, WriteTimeout: 300 * time.Millisecond, MaxRetries: 1,
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /ready", ready)
	mux.HandleFunc("GET /products", listProducts)
	mux.HandleFunc("GET /products/categories", listCategories)
	mux.HandleFunc("GET /products/stats", productStats)
	mux.HandleFunc("GET /products/{id}", getProduct)
	mux.HandleFunc("POST /products", admin(createProduct))
	mux.HandleFunc("PUT /products/{id}", admin(updateProduct))
	mux.HandleFunc("DELETE /products/{id}", admin(deleteProduct))
	mux.HandleFunc("POST /internal/reserve", reserve)
	mux.HandleFunc("POST /internal/release", release)

	srv := &http.Server{Addr: ":" + env("PORT", "8080"), Handler: wrap(mux), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sh)
	}()
	slog.Info("product service listening", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server error", "err", err.Error())
		os.Exit(1)
	}
	_ = mongoClient.Disconnect(context.Background())
}
