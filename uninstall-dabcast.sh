#!/bin/bash
#
# DABcast - Complete uninstallation of DABcast
# Removes everything related to DABcast:
#   - systemd service
#   - binary and files in /opt/dabcast/
#   - data in /var/lib/dabcast/ (presets, logs, runtime, mot)
#   - configuration /etc/default/dabcast
#   - installation log /var/log/dabcast-install.log
#   - dpkg package
#
# Usage: sudo ./uninstall-dabcast.sh
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Error: this script must be run as root (sudo)${NC}"
  exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  DABcast - Complete uninstallation${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${YELLOW}This script removes EVERYTHING related to DABcast:${NC}"
echo -e "${YELLOW}  binary, data, service, configuration, logs.${NC}"
echo -e "${RED}This operation is irreversible. Presets will be lost.${NC}"
echo
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

print_section() {
  echo
  echo -e "${GREEN}==>${NC} $1"
}

# --- Stop service ---
print_section "Stopping and disabling systemd service..."
if systemctl is-active --quiet dabcast.service 2>/dev/null; then
  systemctl stop dabcast.service
  echo -e "  ${GREEN}✓${NC} Service stopped"
else
  echo "  Service already stopped"
fi
if systemctl is-enabled --quiet dabcast.service 2>/dev/null; then
  systemctl disable dabcast.service
  echo -e "  ${GREEN}✓${NC} Service disabled"
else
  echo "  Service already disabled"
fi

# --- Remove dpkg package ---
print_section "Removing dabcast package (dpkg --purge)..."
if dpkg -l dabcast 2>/dev/null | grep -q "^ii"; then
  dpkg --purge dabcast
  echo -e "  ${GREEN}✓${NC} dabcast package removed (purge)"
else
  echo "  dabcast package not found (may have been installed manually)"
fi

# --- Clean up residual files ---
print_section "Removing residual files..."

# Binaire et web
if [ -d /opt/dabcast ]; then
  rm -rf /opt/dabcast
  echo -e "  ${GREEN}✓${NC} /opt/dabcast/ removed"
else
  echo "  /opt/dabcast/: not found"
fi

# Data (presets, runtime logs, mot)
if [ -d /var/lib/dabcast ]; then
  rm -rf /var/lib/dabcast
  echo -e "  ${GREEN}✓${NC} /var/lib/dabcast/ removed"
else
  echo "  /var/lib/dabcast/: not found"
fi

# Service configuration
if [ -f /etc/default/dabcast ]; then
  rm -f /etc/default/dabcast
  echo -e "  ${GREEN}✓${NC} /etc/default/dabcast removed"
else
  echo "  /etc/default/dabcast: not found"
fi

# systemd service file and symlinks (normally removed by dpkg --purge)
for svc_path in \
    /lib/systemd/system/dabcast.service \
    /etc/systemd/system/dabcast.service \
    /etc/systemd/system/multi-user.target.wants/dabcast.service; do
  if [ -e "$svc_path" ]; then
    rm -f "$svc_path"
    echo -e "  ${GREEN}✓${NC} $svc_path removed"
  fi
done

# Installation log
if [ -f /var/log/dabcast-install.log ]; then
  rm -f /var/log/dabcast-install.log
  echo -e "  ${GREEN}✓${NC} /var/log/dabcast-install.log removed"
else
  echo "  /var/log/dabcast-install.log: not found"
fi

# --- Reload systemd ---
print_section "Reloading systemd..."
systemctl daemon-reload
systemctl reset-failed dabcast.service 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} daemon-reload done"

# --- Final verification ---
print_section "Verification..."
RESTE=0
for path in /opt/dabcast /var/lib/dabcast /etc/default/dabcast \
            /lib/systemd/system/dabcast.service \
            /etc/systemd/system/dabcast.service \
            /etc/systemd/system/multi-user.target.wants/dabcast.service \
            /var/log/dabcast-install.log; do
  if [ -e "$path" ]; then
    echo -e "  ${YELLOW}! Still present: $path${NC}"
    RESTE=1
  fi
done
if dpkg -l dabcast 2>/dev/null | grep -q "^ii"; then
  echo -e "  ${YELLOW}! dabcast package still listed by dpkg${NC}"
  RESTE=1
fi

echo
echo -e "${BLUE}========================================${NC}"
if [ "$RESTE" -eq 0 ]; then
  echo -e "${GREEN}DABcast completely uninstalled.${NC}"
else
  echo -e "${YELLOW}Uninstallation complete with residual files remaining (see above).${NC}"
fi
echo -e "${BLUE}========================================${NC}"
echo
