#!/bin/bash
#
# DABcast Installation Script for Debian/Ubuntu
# Installs all required dependencies and sets up the application
#
# Usage: sudo ./install-tools.sh
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Error: This script must be run as root (use sudo)${NC}"
  exit 1
fi

# Get the actual user (not root)
ACTUAL_USER=${SUDO_USER:-$USER}
ACTUAL_HOME=$(getent passwd "$ACTUAL_USER" | cut -d: -f6)

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  DABcast Installation Script${NC}"
echo -e "${BLUE}  Installing for user: $ACTUAL_USER${NC}"
echo -e "${BLUE}========================================${NC}"
echo

# Function to print section headers
print_section() {
  echo
  echo -e "${GREEN}==>${NC} $1"
}

# Function to check if a command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Install optional packages one by one — skips unavailable ones without aborting
install_optional() {
  for pkg in "$@"; do
    if apt-get install -y "$pkg" 2>/dev/null; then
      echo -e "  ${GREEN}✓${NC} $pkg"
    else
      echo -e "  ${YELLOW}⚠ $pkg not available, skipped${NC}"
    fi
  done
}

# Detect OS
print_section "Detecting operating system..."
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
  OS_VERSION=$VERSION_ID
  echo "Detected: $PRETTY_NAME"
else
  echo -e "${RED}Cannot detect OS. /etc/os-release not found.${NC}"
  exit 1
fi

# Check architecture — ODR packages only exist for amd64 and arm64
_ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
if [[ "$_ARCH" != "amd64" && "$_ARCH" != "arm64" && "$_ARCH" != "aarch64" ]]; then
  echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  Unsupported architecture: $_ARCH${NC}"
  echo -e "${RED}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${RED}║  ODR-mmbTools packages are only available for:               ║${NC}"
  echo -e "${RED}║    • amd64  (64-bit PC)                                      ║${NC}"
  echo -e "${RED}║    • arm64  (Raspberry Pi OS 64-bit, ARM servers)            ║${NC}"
  echo -e "${RED}║                                                              ║${NC}"
  echo -e "${RED}║  Solution: use a 64-bit system.                              ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
  exit 1
fi

# Check if Debian/Ubuntu/Raspbian
if [[ "$OS" != "debian" && "$OS" != "ubuntu" && "$OS" != "raspbian" ]]; then
  echo -e "${YELLOW}Warning: This script is designed for Debian/Ubuntu/Raspbian.${NC}"
  echo -e "${YELLOW}Your OS ($OS) may not be fully supported.${NC}"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Update package lists
print_section "Updating package lists..."
apt-get update

# Install basic dependencies
print_section "Installing basic dependencies..."
_BASE_PKGS=(
  curl wget git build-essential automake libtool ca-certificates
  libusb-1.0-0 libusb-1.0-0-dev libzmq3-dev libboost-system-dev
  libcurl4-openssl-dev libasound2-dev procps psmisc netcat-openbsd
)
if ! apt-get install -y "${_BASE_PKGS[@]}"; then
  echo -e "${YELLOW}⚠ Group installation incomplete — attempting package by package...${NC}"
  install_optional "${_BASE_PKGS[@]}"
fi

echo "Installing optional dependencies..."
install_optional libvlc-dev libfdk-aac-dev

# ── Node.js (development mode only) ──────────────────────────────────────────
# Not required when installing via .deb (Node.js 18 is embedded in the
# dabcast binary). Uncomment only to run DABcast from sources.
#
# print_section "Installing Node.js..."
# if command_exists node; then
#   NODE_VERSION=$(node --version)
#   echo "Node.js already installed: $NODE_VERSION"
#   NODE_MAJOR=$(node --version | cut -d'.' -f1 | sed 's/v//')
#   if [ "$NODE_MAJOR" -lt 18 ]; then
#     echo -e "${YELLOW}Node.js version is too old (need v18+). Upgrading...${NC}"
#     INSTALL_NODE=true
#   else
#     echo "Node.js version is sufficient (v18+)"
#     INSTALL_NODE=false
#   fi
# else
#   INSTALL_NODE=true
# fi
# if [ "$INSTALL_NODE" = true ]; then
#   curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
#   apt-get install -y nodejs
#   echo "Node.js installed: $(node --version)"
#   echo "npm installed: $(npm --version)"
# fi
# ──────────────────────────────────────────────────────────────────────────────

# Install ODR-mmbTools
print_section "Installing ODR-mmbTools..."

# Check if we can use PPA (Ubuntu) or backports (Debian)
if [[ "$OS" == "ubuntu" ]]; then
  # Ubuntu: software-properties-common required for add-apt-repository (PPA)
  install_optional software-properties-common

  # Ubuntu: use PPA
  if ! grep -q "opendigitalradio/mmbtools" /etc/apt/sources.list.d/*.list 2>/dev/null; then
    echo "Adding OpenDigitalRadio PPA for Ubuntu..."
    if command_exists add-apt-repository; then
      add-apt-repository -y ppa:opendigitalradio/mmbtools
      apt-get update
    else
      echo -e "${YELLOW}⚠ add-apt-repository not available (software-properties-common missing)${NC}"
      echo -e "${YELLOW}  The OpenDigitalRadio PPA could not be added.${NC}"
      echo -e "${YELLOW}  Install software-properties-common manually then re-run the script.${NC}"
    fi
  else
    echo "OpenDigitalRadio PPA already added"
  fi

  apt-get install -y odr-dabmux odr-audioenc odr-padenc odr-dabmod

elif [[ "$OS" == "debian" || "$OS" == "raspbian" ]]; then
  CODENAME="${VERSION_CODENAME:-}"

  if [[ -z "$CODENAME" ]]; then
    # Fallback to extract codename
    CODENAME="$(awk -F'[() ]' '/VERSION=/{print $3}' /etc/os-release 2>/dev/null || true)"
  fi
  CODENAME="${CODENAME,,}"

  # Tested and supported codenames (no warning)
  _KNOWN="buster bullseye bookworm trixie"
  if [[ ! " $_KNOWN " =~ " $CODENAME " ]]; then
    echo -e "${YELLOW}Warning: $PRETTY_NAME has not been tested with this script.${NC}"
    echo -e "${YELLOW}Tested versions: $_KNOWN${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      exit 1
    fi
  fi

  # Detect ODR binaries compiled from sources (will shadow apt packages)
  _SRC_BINS=()
  for _b in /usr/local/bin/odr-* /usr/local/sbin/odr-*; do
    [[ -f "$_b" ]] && _SRC_BINS+=("$_b")
  done

  if [[ ${#_SRC_BINS[@]} -gt 0 ]]; then
    echo -e "${YELLOW}Warning: ODR binaries compiled from sources are present:${NC}"
    printf '  %s\n' "${_SRC_BINS[@]}"
    echo -e "${YELLOW}These binaries are in /usr/local/bin, which takes priority over /usr/bin.${NC}"
    echo -e "${YELLOW}Any apt packages installed afterwards would be shadowed and ignored.${NC}"

    # Detect binaries not in the apt list (e.g. odr-edi2edi, odr-sourcecompanion...)
    _APT_BIN_NAMES=(odr-dabmux odr-audioenc odr-padenc odr-dabmod)
    _EXTRA_BINS=()
    for _b in "${_SRC_BINS[@]}"; do
      _name=$(basename "$_b")
      _found=false
      for _a in "${_APT_BIN_NAMES[@]}"; do
        [[ "$_name" == "$_a" ]] && _found=true && break
      done
      [[ "$_found" == false ]] && _EXTRA_BINS+=("$_b")
    done
    if [[ ${#_EXTRA_BINS[@]} -gt 0 ]]; then
      echo
      echo -e "${YELLOW}⚠ These source binaries have no apt package equivalent:${NC}"
      printf '    %s\n' "${_EXTRA_BINS[@]}"
      echo -e "${YELLOW}  Option 1 will keep them (no apt package available).${NC}"
    fi

    echo
    echo "Options:"
    echo "  1) Remove source binaries and install apt packages (recommended)"
    echo "  2) Keep source binaries and update via 'git pull + make install'"
    echo "  3) Continue anyway (source binaries will remain active)"
    read -p "Your choice [1/2/3]: " -n 1 -r _ODR_CHOICE
    echo
    case "$_ODR_CHOICE" in
      1)
        # Remove only binaries that have an apt equivalent
        echo "Removing ODR source binaries (apt packages only)..."
        for _b in "${_SRC_BINS[@]}"; do
          _name=$(basename "$_b")
          _is_apt=false
          for _a in "${_APT_BIN_NAMES[@]}"; do
            [[ "$_name" == "$_a" ]] && _is_apt=true && break
          done
          if [[ "$_is_apt" == true ]]; then
            rm -f "$_b"
            echo -e "  ${GREEN}✓${NC} removed: $_b"
          else
            echo -e "  ${BLUE}→${NC} kept: $_b (no apt package equivalent)"
          fi
        done
        ;;
      2)
        echo -e "${YELLOW}Keeping source binaries. apt installation skipped for ODR tools.${NC}"
        echo "To update:"
        echo "  cd <source-directory> && git pull && make && sudo make install"
        # Skip apt installation of ODR tools
        _SKIP_ODR_APT=true
        ;;
      *)
        echo -e "${YELLOW}Continuing — source binaries will shadow apt packages.${NC}"
        ;;
    esac
  fi

  ODR_PKGS=(odr-dabmux odr-audioenc odr-padenc odr-dabmod)

  if [[ "${_SKIP_ODR_APT:-false}" == "true" ]]; then
    echo "apt installation of ODR tools skipped (source binaries kept)."
  elif [[ "$OS" == "raspbian" ]]; then
    # Raspbian legacy: should not happen (blocked by architecture check above)
    echo -e "${RED}Raspbian not supported (32-bit architecture).${NC}"
    exit 1

  else
    # Debian : via backports
    COMPONENTS="main contrib non-free"
    if [[ "$CODENAME" == "bookworm" || "$CODENAME" == "trixie" ]]; then
      COMPONENTS+=" non-free-firmware"
    fi

    BACKPORTS_LIST="/etc/apt/sources.list.d/${CODENAME}-backports.list"
    echo "Adding/updating Debian backports: $BACKPORTS_LIST"
    echo "deb http://deb.debian.org/debian ${CODENAME}-backports ${COMPONENTS}" > "$BACKPORTS_LIST"
    apt-get update

    # On trixie/sid, ODR packages may be in the main repository (testing)
    # → try package by package: standard repository first, then backports, then
    #   bookworm-backports as last resort (ODR packages not yet migrated to trixie)
    if [[ "$CODENAME" == "trixie" || "$CODENAME" == "sid" ]]; then
      BOOKWORM_BP_LIST="/etc/apt/sources.list.d/bookworm-backports.list"
      if [[ ! -f "$BOOKWORM_BP_LIST" ]]; then
        echo "Adding bookworm-backports as fallback repository..."
        echo "deb http://deb.debian.org/debian bookworm-backports main contrib non-free non-free-firmware" > "$BOOKWORM_BP_LIST"
        # Pin bookworm-backports at low priority: only used when explicitly requested
        # via -t, never automatically by apt-get upgrade
        cat > /etc/apt/preferences.d/bookworm-backports-pin <<'PINEOF'
Package: *
Pin: release a=bookworm-backports
Pin-Priority: 100
PINEOF
        apt-get update -qq
      fi

      echo "Installing ODR (${CODENAME}): attempting package by package..."
      for pkg in "${ODR_PKGS[@]}"; do
        if apt-get install -y "$pkg" 2>/dev/null; then
          echo -e "  ${GREEN}✓${NC} $pkg (${CODENAME})"
        elif apt-get install -y -t "${CODENAME}-backports" "$pkg" 2>/dev/null; then
          echo -e "  ${GREEN}✓${NC} $pkg (${CODENAME}-backports)"
        elif apt-get install -y -t bookworm-backports "$pkg" 2>/dev/null; then
          echo -e "  ${GREEN}✓${NC} $pkg (bookworm-backports)"
        else
          echo -e "  ${YELLOW}⚠ $pkg not available on ${CODENAME}, ${CODENAME}-backports or bookworm-backports, skipped${NC}"
        fi
      done
    else
      echo "Installing ODR tools from ${CODENAME}-backports: ${ODR_PKGS[*]}"
      apt-get install -y -t "${CODENAME}-backports" "${ODR_PKGS[@]}"
    fi
  fi
fi

# Verify ODR tools installation
echo "Installed ODR tools:"
which odr-dabmux && odr-dabmux --version | head -1 || echo -e "${YELLOW}odr-dabmux not found${NC}"
which odr-audioenc && odr-audioenc --version | head -1 || echo -e "${YELLOW}odr-audioenc not found${NC}"
which odr-padenc && odr-padenc --version | head -1 || echo -e "${YELLOW}odr-padenc not found${NC}"
which odr-dabmod && odr-dabmod --version | head -1 || echo -e "${YELLOW}odr-dabmod not found (optional for TX)${NC}"

# Install ImageMagick (for SLS image conversion)
print_section "Installing ImageMagick..."
apt-get install -y imagemagick
which convert && convert --version | head -1

# Install monitoring tools (dablin + ffmpeg are also used by the web Player)
print_section "Installing monitoring tools..."
install_optional dablin socat wmctrl xdotool ffmpeg

# Install HackRF support (optional)
print_section "Installing HackRF support..."
read -p "Install HackRF support (libhackrf, hackrf tools)? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  apt-get install -y libhackrf-dev hackrf
  which hackrf_transfer && hackrf_transfer --version || echo "hackrf_transfer installed"
  echo -e "${GREEN}HackRF support installed${NC}"
else
  echo "Skipping HackRF installation"
fi

# ── DABcast npm dependencies (development mode only) ─────────────────────────
# Not required when installing via .deb (everything is embedded in the binary).
# Uncomment only to run DABcast from sources (npm start).
#
# print_section "Installing DABcast Node.js dependencies..."
# SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# SERVER_DIR="$SCRIPT_DIR/server"
# if [ -d "$SERVER_DIR" ]; then
#   echo "Running npm install as user $ACTUAL_USER..."
#   su - "$ACTUAL_USER" -c "cd '$SERVER_DIR' && npm install"
#   echo -e "${GREEN}Node.js dependencies installed${NC}"
# else
#   echo -e "${YELLOW}Warning: server/ directory not found at $SERVER_DIR${NC}"
#   echo "Skipping npm install. Make sure to run 'npm install' manually."
# fi
# ──────────────────────────────────────────────────────────────────────────────

# Summary
print_section "Installation Summary"
echo -e "${GREEN}✓${NC} odr-dabmux: $(which odr-dabmux 2>/dev/null || echo 'not found')"
echo -e "${GREEN}✓${NC} odr-audioenc: $(which odr-audioenc 2>/dev/null || echo 'not found')"
echo -e "${GREEN}✓${NC} odr-padenc: $(which odr-padenc 2>/dev/null || echo 'not found')"
echo -e "${GREEN}✓${NC} odr-dabmod: $(which odr-dabmod 2>/dev/null || echo 'not found')"
echo -e "${GREEN}✓${NC} ImageMagick: $(which convert 2>/dev/null || echo 'not found')"

if command_exists hackrf_transfer; then
  echo -e "${GREEN}✓${NC} HackRF: $(which hackrf_transfer)"
fi

if command_exists dablin; then
  echo -e "${GREEN}✓${NC} Dablin: $(which dablin)"
fi

if command_exists ffmpeg; then
  echo -e "${GREEN}✓${NC} ffmpeg (web Player): $(which ffmpeg)"
fi

echo
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}ODR tools installed successfully!${NC}"
echo -e "${BLUE}========================================${NC}"
echo
echo "Next step: install DABcast"
echo "  sudo dpkg -i dabcast_X.Y.Z_amd64.deb"
echo "  Then open http://localhost:9090"
echo
echo "For more information, see build/INSTALL.md"
echo
