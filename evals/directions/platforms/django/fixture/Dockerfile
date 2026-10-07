FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p /data && chmod +x bin/product-count bin/openreceive-installed
ENV PYTHONUNBUFFERED=1
ENV DJANGO_SETTINGS_MODULE=widgetshop.settings
EXPOSE 3000
CMD ["sh", "-c", "python manage.py migrate --noinput && python manage.py runserver 0.0.0.0:3000"]
