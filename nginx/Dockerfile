FROM nginx:1.27-alpine
# Our conf declares the default servers; the stock one would conflict.
RUN rm -f /etc/nginx/conf.d/default.conf

# The actual site config is rendered on the VM by start.sh into
# rendered/nginx/eagler.conf and mounted read-only. Nothing to bake in here.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:80/nginx-health || exit 1
