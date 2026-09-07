"""The Django adapter: an installable app (`openreceive.django`) that mounts the
framework-free handler as thin views, stores payment attempts through the ORM
in the host's own database (two tables, one shipped migration), and wraps the
engine's doctor / reconcile / notifications worker as management commands.

    INSTALLED_APPS += ["openreceive.django"]
    OPENRECEIVE = {"HOST": "shop.openreceive_host.Host"}
    urlpatterns += [path("openreceive/", include("openreceive.django.urls"))]

Nothing here runs at import or at `AppConfig.ready()` beyond registering the
system checks: the wallet client is built lazily on the first request (plan
0.8), so `migrate`, `collectstatic` and shells work on a box with no relay.
"""
