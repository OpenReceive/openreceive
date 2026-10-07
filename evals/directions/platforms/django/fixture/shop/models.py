from django.db import models


class Product(models.Model):
    name = models.CharField(max_length=80)
    price = models.CharField(max_length=20)
    sku = models.CharField(max_length=40, unique=True)


class Customer(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)


class Order(models.Model):
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE)
    product_name = models.CharField(max_length=80)
    amount = models.CharField(max_length=20)
    currency = models.CharField(max_length=8, default="USD")
    status = models.CharField(max_length=40, default="awaiting_payment")
