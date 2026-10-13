FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p /data
ENV PYTHONUNBUFFERED=1
EXPOSE 5000
# One worker with threads: the engine is synchronous and thread-safe, and one
# process creates the tables at start.
CMD ["gunicorn", "--workers", "1", "--threads", "8", "--bind", "0.0.0.0:5000", "app:app"]
