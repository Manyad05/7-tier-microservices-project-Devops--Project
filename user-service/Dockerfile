FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
RUN useradd -u 10001 -r -s /usr/sbin/nologin app
USER 10001
EXPOSE 5000
HEALTHCHECK --interval=10s --timeout=4s --start-period=40s --retries=5 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:5000/health',timeout=3)"
CMD ["gunicorn", "--preload", "-k", "gthread", "-w", "2", "--threads", "4", "--worker-tmp-dir", "/dev/shm", "--log-level", "warning", "-b", "0.0.0.0:5000", "app:app"]
