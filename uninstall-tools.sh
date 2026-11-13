#!/bin/bash
#
# DABcast - Uninstallation of system tools
# Removes everything installed by install-tools.sh:
#   odr-dabmux, odr-audioenc, odr-padenc, odr-dabmod
#   ImageMagick, dablin, socat, wmctrl, xdotool
#   SDR support: SoapySDR drivers, HackRF / LimeSDR / BladeRF tools (if installed)
#   ODR build dependencies
#   ODR PPA/backports source
#
# Usage: sudo ./uninstall-tools.sh
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
echo -e "${BLUE}  DABcast - Uninstallation of tools${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${YELLOW}This script removes the tools installed by install-tools.sh.${NC}"
echo -e "${YELLOW}Common packages (curl, wget, git, build-essential) are${NC}"
echo -e "${YELLOW}also removed — if they were pre-existing, reinstall them manually.${NC}"
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

# --- Detect OS ---
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
  CODENAME="${VERSION_CODENAME:-}"
fi

# --- ODR tools ---
print_section "Removing ODR tools..."
ODR_PKGS="odr-dabmux odr-audioenc odr-padenc odr-dabmod"
for pkg in $ODR_PKGS; do
  if dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
    apt-get remove -y "$pkg"
    echo -e "  ${GREEN}✓${NC} $pkg removed"
  else
    echo "  $pkg: not installed, skipped"
  fi
done

# --- Source PPA / backports ODR ---
print_section "Removing ODR package source..."
if [[ "$OS" == "ubuntu" ]]; then
  if grep -r "opendigitalradio/mmbtools" /etc/apt/sources.list.d/ >/dev/null 2>&1; then
    add-apt-repository --remove -y ppa:opendigitalradio/mmbtools 2>/dev/null || \
      rm -f /etc/apt/sources.list.d/*opendigitalradio*.list
    echo -e "  ${GREEN}✓${NC} OpenDigitalRadio PPA removed"
  else
    echo "  PPA not found, skipped"
  fi
elif [[ "$OS" == "debian" ]]; then
  BACKPORTS_LIST="/etc/apt/sources.list.d/${CODENAME}-backports.list"
  if [ -f "$BACKPORTS_LIST" ]; then
    rm -f "$BACKPORTS_LIST"
    echo -e "  ${GREEN}✓${NC} $BACKPORTS_LIST removed"
  else
    echo "  Backports not found, skipped"
  fi
  # Removing bookworm-backports repository added for trixie/sid
  BOOKWORM_BP_LIST="/etc/apt/sources.list.d/bookworm-backports.list"
  if [ -f "$BOOKWORM_BP_LIST" ]; then
    rm -f "$BOOKWORM_BP_LIST"
    echo -e "  ${GREEN}✓${NC} $BOOKWORM_BP_LIST removed"
  fi
  # Removing the non-free component added for odr-audioenc (Debian 13 and newer)
  if [ -f /etc/apt/sources.list.d/dabcast-non-free.list ]; then
    rm -f /etc/apt/sources.list.d/dabcast-non-free.list
    echo -e "  ${GREEN}✓${NC} /etc/apt/sources.list.d/dabcast-non-free.list removed"
  fi
  # Removing bookworm-backports pin
  BOOKWORM_PIN="/etc/apt/preferences.d/bookworm-backports-pin"
  if [ -f "$BOOKWORM_PIN" ]; then
    rm -f "$BOOKWORM_PIN"
    echo -e "  ${GREEN}✓${NC} $BOOKWORM_PIN removed"
  fi
fi

# --- Monitoring tools ---
print_section "Removing monitoring tools..."
for pkg in dablin socat wmctrl xdotool; do
  if dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
    apt-get remove -y "$pkg"
    echo -e "  ${GREEN}✓${NC} $pkg removed"
  else
    echo "  $pkg: not installed, skipped"
  fi
done

# --- ImageMagick ---
print_section "Removing ImageMagick..."
if dpkg -l imagemagick 2>/dev/null | grep -q "^ii"; then
  apt-get remove -y imagemagick
  echo -e "  ${GREEN}✓${NC} imagemagick removed"
else
  echo "  imagemagick: not installed, skipped"
fi

# --- HackRF ---
print_section "Removing SDR support (SoapySDR, HackRF, LimeSDR, BladeRF)..."
for pkg in soapysdr0.8-module-all soapysdr0.8-module-hackrf soapysdr0.8-module-lms7 soapysdr0.8-module-bladerf \
           soapysdr-tools limesuite bladerf libhackrf-dev hackrf; do
  if dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
    apt-get remove -y "$pkg"
    echo -e "  ${GREEN}✓${NC} $pkg removed"
  else
    echo "  $pkg: not installed, skipped"
  fi
done

# --- Build dependencies ---
print_section "Removing build dependencies..."
BUILD_PKGS="software-properties-common build-essential automake libtool \
  libusb-1.0-0-dev libzmq3-dev libboost-system-dev libcurl4-openssl-dev \
  libasound2-dev libasound2t64-dev libfdk-aac-dev libvlc-dev libusb-1.0-0"
for pkg in $BUILD_PKGS; do
  if dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
    apt-get remove -y "$pkg"
    echo -e "  ${GREEN}✓${NC} $pkg removed"
  else
    echo "  $pkg: not installed, skipped"
  fi
done

# --- Common packages (optional) ---
print_section "Removing utility packages (curl, wget, git...)..."
echo -e "${YELLOW}Warning: these packages may be used by other software.${NC}"
read -p "Remove curl, wget, git, procps, psmisc, ca-certificates, netcat-openbsd? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  for pkg in curl wget git procps psmisc ca-certificates netcat-openbsd; do
    if dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
      apt-get remove -y "$pkg"
      echo -e "  ${GREEN}✓${NC} $pkg removed"
    else
      echo "  $pkg: not installed, skipped"
    fi
  done
else
  echo "  Skipped."
fi

# --- Orphan package cleanup ---
print_section "Cleaning up orphan dependencies..."
apt-get autoremove -y
apt-get update

echo
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Tool uninstallation complete.${NC}"
echo -e "${BLUE}========================================${NC}"
echo
