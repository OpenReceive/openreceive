"""The server: `Service` (wallet + rates + swaps), the framework-free
`RequestHandler` (request → status/body/headers), `OpenReceiveApp` (handler +
repository + the gated opportunistic reconcile), the notifications worker,
the doctor report, and the `Host` contract."""

from openreceive.server.app import OpenReceiveApp
from openreceive.server.doctor import DoctorReport, doctor_report
from openreceive.server.errors import ConfigurationError, ServiceError
from openreceive.server.handler import HookContext, HttpRequest, HttpResponse, RequestHandler
from openreceive.server.hosts import ALLOW_ALL_AUTHORIZE, LOGGING_ON_PAID, Host
from openreceive.server.notifications import run_notifications_worker
from openreceive.server.reconcile import Reconciler
from openreceive.server.service import Service

__all__ = [
    "ALLOW_ALL_AUTHORIZE",
    "LOGGING_ON_PAID",
    "ConfigurationError",
    "DoctorReport",
    "HookContext",
    "Host",
    "HttpRequest",
    "HttpResponse",
    "OpenReceiveApp",
    "Reconciler",
    "RequestHandler",
    "Service",
    "ServiceError",
    "doctor_report",
    "run_notifications_worker",
]
