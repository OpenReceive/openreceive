# Odoo's official image plus the openreceive package, the way the quickstart
# installs it, from a wheel built from this checkout. Odoo's image keeps its
# Python packages under Debian's control: typing_extensions and h11 are
# installed beside Debian's copies, which pip cannot replace, and Debian's own
# cryptography stays in use.
ARG ODOO=19.0
FROM odoo:${ODOO}
USER root
COPY wheel/ /tmp/wheel/
RUN pip3 install --no-cache-dir --break-system-packages --ignore-installed typing_extensions h11 \
 && pip3 install --no-cache-dir --break-system-packages /tmp/wheel/*.whl \
 && rm -rf /tmp/wheel
USER odoo
