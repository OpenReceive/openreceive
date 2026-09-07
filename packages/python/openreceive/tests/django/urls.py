from django.urls import include, path

urlpatterns = [path("openreceive/", include("openreceive.django.urls"))]
