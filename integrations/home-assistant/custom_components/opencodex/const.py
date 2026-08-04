"""Constants for the opencodex usage meter integration."""

DOMAIN = "opencodex"

DEFAULT_PORT = 10100
# The proxy caches /api/usage summaries server-side, so a short interval is cheap.
DEFAULT_SCAN_INTERVAL_SECONDS = 60

# Usage ranges the proxy accepts. 7d matches the dashboard's default view.
USAGE_RANGE = "7d"
