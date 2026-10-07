from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [
        migrations.CreateModel(
            name="Product",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=80)),
                ("price", models.CharField(max_length=20)),
                ("sku", models.CharField(max_length=40, unique=True)),
            ],
        ),
        migrations.CreateModel(
            name="Customer",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
        ),
        migrations.CreateModel(
            name="Order",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("product_name", models.CharField(max_length=80)),
                ("amount", models.CharField(max_length=20)),
                ("currency", models.CharField(default="USD", max_length=8)),
                ("status", models.CharField(default="awaiting_payment", max_length=40)),
                ("customer", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="shop.customer")),
            ],
        ),
    ]
