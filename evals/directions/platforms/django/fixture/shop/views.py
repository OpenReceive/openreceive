from django.http import HttpResponse, HttpResponseNotAllowed
from django.shortcuts import get_object_or_404, redirect, render

from .models import Customer, Order, Product


def index(request):
    return render(request, "index.html", {"products": Product.objects.order_by("id")})


def health(_request):
    return HttpResponse("ok\n", content_type="text/plain")


def create_order(request):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    product = get_object_or_404(Product, id=request.POST.get("product_id"))
    customer_id = request.session.get("customer_id")
    if not customer_id or not Customer.objects.filter(id=customer_id).exists():
        customer = Customer.objects.create()
        request.session["customer_id"] = customer.id
        customer_id = customer.id
    order = Order.objects.create(
        customer_id=customer_id,
        product_name=product.name,
        amount=product.price,
        currency="USD",
        status="awaiting_payment",
    )
    return redirect("order", order_id=order.id)


def order(request, order_id):
    customer_id = request.session.get("customer_id")
    found = Order.objects.filter(id=order_id, customer_id=customer_id).first()
    if found is None:
        return HttpResponse("That order is not yours.", status=404, content_type="text/plain")
    return render(request, "order.html", {"order": found})
