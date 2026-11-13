#!/bin/bash
#
# DABcast installation script for Debian / Raspberry Pi OS / Ubuntu
# Installs the ODR-mmbTools and everything DABcast can use, then DABcast itself (latest release).
# Everything that can be useful is installed (build tools, Dablin window helpers…) so that the
# installation keeps working when a desktop is added later. Only the real choices are asked, with a
# default: SDR support, updating ODR tools already installed (versions shown), installing DABcast.
#
# Usage: sudo bash install-tools.sh [--yes] [--tools-only]
#   --yes          answer every question with its default (unattended installation)
#   --tools-only   install the tools only, not DABcast (e.g. to run DABcast from its sources)
#

set -e
export DEBIAN_FRONTEND=noninteractive   # no package configuration dialog during the installation
# Every apt-get call waits for the apt lock (up to 3 min) instead of failing at once: on Raspberry Pi
# OS with a desktop, PackageKit / unattended-upgrades often hold it for a while (a package was then
# skipped, e.g. soapysdr-tools)
apt-get() { command apt-get -o DPkg::Lock::Timeout=180 "$@"; }

TOOLS_ONLY=false
ASSUME_YES=false
for _arg in "$@"; do
  case "$_arg" in
    --tools-only) TOOLS_ONLY=true ;;
    -y|--yes) ASSUME_YES=true ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $_arg (see --help)"; exit 1 ;;
  esac
done

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

# Yes/no question: ask "Question" Y|N (default). Reads the terminal; no answer = the default,
# never aborts the script (set -e) when there is no terminal.
ask() {
  local _def="${2:-N}" _ans=""
  local _hint="(y/N)"; [[ "$_def" == "Y" ]] && _hint="(Y/n)"
  if [[ "$ASSUME_YES" == "true" ]]; then echo "$1 $_hint -> ${_def} (--yes)"
  elif [[ -r /dev/tty ]]; then read -r -p "$1 $_hint " _ans < /dev/tty || _ans=""; fi
  _ans="${_ans:-$_def}"
  [[ "$_ans" =~ ^[Yy] ]]
}

# Install optional packages one by one — skips unavailable ones without aborting
install_optional() {
  local pkg out
  for pkg in "$@"; do
    if out=$(apt-get install -y "$pkg" 2>&1); then
      echo -e "  ${GREEN}✓${NC} $pkg"
    else
      # the reason given by apt (not available, lock, dependency…), not just "skipped"
      echo -e "  ${YELLOW}⚠ $pkg not installed: $(echo "$out" | grep -E '^(E|W): ' | tail -1 | cut -c1-160)${NC}"
    fi
  done
}

ODR_PKGS=(odr-dabmux odr-audioenc odr-padenc odr-dabmod)

# Newest version of a package in the configured repositories (empty if none)
newest_version() {
  local best="" v
  for v in $(apt-cache madison "$1" 2>/dev/null | awk -F'|' '{gsub(/ /, "", $2); print $2}'); do
    if [[ -z "$best" ]] || dpkg --compare-versions "$v" gt "$best"; then best="$v"; fi
  done
  echo "$best"
}
# ODR tools: first installation → no question. Already installed → table of the installed / available
# versions and one question before updating them (missing ones are installed in any case).
# Sets ODR_PKGS to what must be installed; returns 1 when there is nothing to install.
odr_confirm() {
  local p inst avail missing=() newer=() installed=false _ODR_TABLE=""
  for p in "${ODR_PKGS[@]}"; do
    inst=$(dpkg-query -W -f='${Status}|${Version}' "$p" 2>/dev/null | awk -F'|' '/install ok installed/{print $2}' || true)
    avail=$(newest_version "$p")
    if [[ -z "$inst" ]]; then missing+=("$p")
    else
      installed=true
      if [[ -n "$avail" ]] && dpkg --compare-versions "$avail" gt "$inst"; then newer+=("$p"); fi
    fi
    _ODR_TABLE+=$(printf '\n  %-14s %-28s %s' "$p" "${inst:-(not installed)}" "${avail:-(not available)}")
  done
  echo "  tool           installed                    available${_ODR_TABLE}"
  if [[ "$installed" == "false" ]]; then return 0; fi
  if [[ ${#newer[@]} -gt 0 ]] && ask "Update the ODR tools (${newer[*]}) to the available versions?" Y; then
    ODR_PKGS=("${missing[@]}" "${newer[@]}")
  else
    [[ ${#newer[@]} -eq 0 ]] && echo -e "  ${GREEN}✓${NC} installed ODR tools are up to date"
    ODR_PKGS=("${missing[@]}")
  fi
  [[ ${#ODR_PKGS[@]} -gt 0 ]]
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
  if ! ask "Continue anyway?" N; then
    exit 1
  fi
fi

# Update package lists
print_section "Updating package lists..."
apt-get update

# Install basic dependencies
print_section "Installing basic dependencies..."
# sudo: the one-click update of DABcast relies on it (missing on a minimal Debian with a root password)
# file: used by the DABcast package to check its binary. Build tools: kept to compile a driver or a
# tool from its sources later (e.g. SoapyPlutoSDR).
_BASE_PKGS=(
  curl wget git build-essential automake libtool ca-certificates sudo file
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
# Not required when installing via .deb (Node.js 24 is embedded in the
# dabcast binary). Uncomment only to run DABcast from sources.
#
# print_section "Installing Node.js..."
# if command_exists node; then
#   NODE_VERSION=$(node --version)
#   echo "Node.js already installed: $NODE_VERSION"
#   NODE_MAJOR=$(node --version | cut -d'.' -f1 | sed 's/v//')
#   if [ "$NODE_MAJOR" -lt 24 ]; then
#     echo -e "${YELLOW}Node.js version is too old (need v24+). Upgrading...${NC}"
#     INSTALL_NODE=true
#   else
#     echo "Node.js version is sufficient (v24+)"
#     INSTALL_NODE=false
#   fi
# else
#   INSTALL_NODE=true
# fi
# if [ "$INSTALL_NODE" = true ]; then
#   curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
#   apt-get install -y nodejs
#   echo "Node.js installed: $(node --version)"
#   echo "npm installed: $(npm --version)"
# fi
# ──────────────────────────────────────────────────────────────────────────────

# Install ODR-mmbTools
print_section "Installing ODR-mmbTools..."

# Ubuntu: official archive (universe / multiverse); Debian 12: backports; Debian 13+: standard repository
if [[ "$OS" == "ubuntu" ]]; then
  # Ubuntu: the ODR tools are in the official archive (universe; odr-audioenc in multiverse, as it
  # uses fdk-aac) — Ubuntu 26.04 LTS or newer for odr-audioenc. The former opendigitalradio PPA
  # no longer exists.
  install_optional software-properties-common
  if command_exists add-apt-repository; then
    add-apt-repository -y universe || true
    add-apt-repository -y multiverse || true
    apt-get update
  else
    echo -e "${YELLOW}⚠ add-apt-repository not available: make sure universe and multiverse are enabled${NC}"
  fi
  if odr_confirm; then install_optional "${ODR_PKGS[@]}"; fi
  if ! command_exists odr-audioenc; then
    echo -e "${YELLOW}⚠ odr-audioenc is not available on $PRETTY_NAME (it is in Ubuntu 26.04 LTS and newer, multiverse).${NC}"
    echo -e "${YELLOW}  Use Ubuntu 26.04+ or Debian 12 / 13, or build ODR-AudioEnc from its sources.${NC}"
  fi

elif [[ "$OS" == "debian" || "$OS" == "raspbian" ]]; then
  CODENAME="${VERSION_CODENAME:-}"

  if [[ -z "$CODENAME" ]]; then
    # Fallback to extract codename
    CODENAME="$(awk -F'[() ]' '/VERSION=/{print $3}' /etc/os-release 2>/dev/null || true)"
  fi
  CODENAME="${CODENAME,,}"

  # Debian 10 / 11 have no ODR package (and their backports are archived)
  if [[ "$CODENAME" == "buster" || "$CODENAME" == "bullseye" ]]; then
    echo -e "${RED}$PRETTY_NAME is too old: the ODR tools exist for Debian 12 (bookworm, backports) and 13 (trixie) or newer.${NC}"
    echo -e "${RED}Upgrade the system (Raspberry Pi: Raspberry Pi OS 64-bit based on bookworm or trixie).${NC}"
    exit 1
  fi
  # Tested and supported codenames (no warning); newer ones (forky, sid) use the standard repository
  _KNOWN="bookworm trixie"
  if [[ ! " $_KNOWN " =~ " $CODENAME " ]]; then
    echo -e "${YELLOW}Warning: $PRETTY_NAME has not been tested with this script (tested: $_KNOWN) — continuing.${NC}"
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
    _ODR_CHOICE=""
    if [[ -r /dev/tty ]]; then read -r -p "Your choice [1/2/3]: " _ODR_CHOICE < /dev/tty || _ODR_CHOICE=""; fi
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

  if [[ "${_SKIP_ODR_APT:-false}" == "true" ]]; then
    echo "apt installation of ODR tools skipped (source binaries kept)."
  elif [[ "$OS" == "raspbian" ]]; then
    # Raspbian legacy: should not happen (blocked by architecture check above)
    echo -e "${RED}Raspbian not supported (32-bit architecture).${NC}"
    exit 1

  elif [[ "$CODENAME" == "bookworm" ]]; then
    # Debian 12: ODR tools from bookworm-backports (odr-audioenc in non-free)
    BACKPORTS_LIST="/etc/apt/sources.list.d/${CODENAME}-backports.list"
    echo "Adding/updating Debian backports: $BACKPORTS_LIST"
    echo "deb http://deb.debian.org/debian ${CODENAME}-backports main contrib non-free non-free-firmware" > "$BACKPORTS_LIST"
    apt-get update
    if odr_confirm; then
      echo "Installing ODR tools from ${CODENAME}-backports: ${ODR_PKGS[*]}"
      apt-get install -y -t "${CODENAME}-backports" "${ODR_PKGS[@]}"
    fi

  else
    # Debian 13 (trixie) and newer: ODR tools in the standard repository (the versions DABcast is
    # tested with) — no backports, never packages of another Debian release.
    # odr-audioenc is in non-free, not enabled by a default installation.
    # madison lists the installable versions (apt-cache show also succeeds for a package only referred to)
    if [[ -z "$(apt-cache madison odr-audioenc 2>/dev/null)" ]]; then
      # DABcast cannot work without odr-audioenc (it uses fdk-aac, hence 'non-free')
      echo -e "${YELLOW}odr-audioenc is in the Debian 'non-free' component: enabling it for ${CODENAME}${NC}"
      echo "  (file /etc/apt/sources.list.d/dabcast-non-free.list — removed by uninstall-tools.sh)"
      echo "deb http://deb.debian.org/debian ${CODENAME} non-free" > /etc/apt/sources.list.d/dabcast-non-free.list
      apt-get update
    fi
    if odr_confirm; then
      echo "Installing ODR tools (${CODENAME}): ${ODR_PKGS[*]}"
      install_optional "${ODR_PKGS[@]}"
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

# SDR support: the SDR output of DABcast (odr-dabmod drives the device through SoapySDR). One
# question for all the drivers, so that an SDR plugged in later works without installing anything.
print_section "SDR support (SoapySDR and drivers: HackRF, LimeSDR, BladeRF, USRP, RTL-SDR…)"
if ask "Install SDR support (an SDR plugged into this machine: HackRF, LimeSDR, BladeRF…)?" Y; then
  install_optional soapysdr-tools soapysdr0.8-module-all soapysdr0.8-module-hackrf soapysdr0.8-module-lms7 \
    soapysdr0.8-module-bladerf hackrf limesuite bladerf
  echo -e "  ${BLUE}PlutoSDR:${NC} no Debian package for its SoapySDR driver — build SoapyPlutoSDR from"
  echo "    https://github.com/pothosware/SoapyPlutoSDR (build tools installed; needs libiio-dev libad9361-dev libsoapysdr-dev cmake)."
  echo "    A stock PlutoSDR does not go below 325 MHz (DAB Band III = 174-240 MHz)."
  # summary from the packages really installed (SoapySDRUtil may be missing)
  _DRV=$(dpkg-query -W -f='${Status} ${Package}\n' 'soapysdr0.8-module-*' 2>/dev/null \
    | awk '/install ok installed/{sub("soapysdr0.8-module-", "", $4); if ($4 != "all") print $4}' | tr '\n' ' ')
  echo -e "  SoapySDR drivers ready: ${_DRV:-none}"
  command_exists SoapySDRUtil || echo -e "  ${YELLOW}⚠ SoapySDRUtil missing (soapysdr-tools): the 'Check device' button of DABcast needs it${NC}"
  _GROUPS="plugdev audio"   # USB access to the SDRs (udev rules: group plugdev)
else
  echo "Skipping SDR support (DABcast works without it: network outputs only; run the script again to add it)"
  _GROUPS="audio"
fi

# Groups of the user who runs DABcast: audio (ALSA sound card sources), plugdev (SDR)
if [[ -n "$ACTUAL_USER" && "$ACTUAL_USER" != "root" ]] && id -u "$ACTUAL_USER" >/dev/null 2>&1; then
  for _grp in $_GROUPS; do
    if getent group "$_grp" >/dev/null && ! id -nG "$ACTUAL_USER" | tr ' ' '\n' | grep -qx "$_grp"; then
      usermod -aG "$_grp" "$ACTUAL_USER" && echo -e "  ${GREEN}✓${NC} $ACTUAL_USER added to group $_grp" && _GROUPS_ADDED=true
    fi
  done
fi

# Clock: EDI timestamps (TIST), EasyDAB metadata and HTTPS certificates need the right time
print_section "Checking time synchronisation..."
if [[ -d /run/systemd/system ]]; then
  if systemctl is-active --quiet systemd-timesyncd || systemctl is-active --quiet chrony \
     || systemctl is-active --quiet chronyd || systemctl is-active --quiet ntpsec || systemctl is-active --quiet ntp; then
    echo -e "  ${GREEN}✓${NC} time synchronisation already active"
  else
    install_optional systemd-timesyncd
    systemctl enable --now systemd-timesyncd 2>/dev/null && echo -e "  ${GREEN}✓${NC} systemd-timesyncd enabled" \
      || echo -e "  ${YELLOW}⚠ could not enable systemd-timesyncd: check the clock (timedatectl)${NC}"
  fi
else
  echo "  systemd not running (container): skipped"
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

if command_exists SoapySDRUtil; then
  echo -e "${GREEN}✓${NC} SoapySDR (SDR output): $(which SoapySDRUtil)"
fi

if command_exists dablin; then
  echo -e "${GREEN}✓${NC} Dablin: $(which dablin)"
fi

if command_exists ffmpeg; then
  echo -e "${GREEN}✓${NC} ffmpeg (web Player): $(which ffmpeg)"
fi

_MISSING=()
for _t in odr-dabmux odr-audioenc odr-padenc; do command_exists "$_t" || _MISSING+=("$_t"); done
_DEB_ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)
_REPO="DABodr/DABcast-diffusion-software"
_MANUAL_STEPS() {
  echo "  Download the package for this machine (${_DEB_ARCH}) from"
  echo "    https://github.com/${_REPO}/releases/latest"
  echo "  then: sudo dpkg -i dabcast_X.Y.Z_${_DEB_ARCH}.deb"
}

# DABcast itself: the latest official release for this architecture (skipped with --tools-only)
_DABCAST_OK=false
if [[ "$TOOLS_ONLY" == "true" ]]; then
  print_section "DABcast not installed (--tools-only)"
elif [[ "$_DEB_ARCH" != "amd64" && "$_DEB_ARCH" != "arm64" ]]; then
  print_section "DABcast: no package for $_DEB_ARCH"
else
  print_section "Installing DABcast (latest release)..."
  _LATEST=$(curl -fsSL --max-time 20 "https://api.github.com/repos/${_REPO}/releases/latest" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"v?([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')
  _INSTALLED=$(dpkg-query -W -f='${Status} ${Version}' dabcast 2>/dev/null | awk '/install ok installed/{print $4}')
  if [[ ! "$_LATEST" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${YELLOW}⚠ Could not read the latest release from GitHub. Install DABcast by hand:${NC}"
    _MANUAL_STEPS
  elif [[ "$_INSTALLED" == "$_LATEST" ]]; then
    echo -e "  ${GREEN}✓${NC} DABcast ${_INSTALLED} already installed (latest release)"
    _DABCAST_OK=true
  elif ! ask "$([[ -n "$_INSTALLED" ]] && echo "Update DABcast ${_INSTALLED} → ${_LATEST} now?" || echo "Install DABcast ${_LATEST} (${_DEB_ARCH}) now?")" Y; then
    echo "  DABcast not installed now. To install it later:"
    _MANUAL_STEPS
    _DABCAST_SKIPPED=true
  else
    _TMPD=$(mktemp -d)
    _DEB="$_TMPD/dabcast_${_LATEST}_${_DEB_ARCH}.deb"
    echo "  Downloading DABcast ${_LATEST} (${_DEB_ARCH})${_INSTALLED:+ — installed: ${_INSTALLED}}..."
    if curl -fL --max-time 600 -o "$_DEB" "https://github.com/${_REPO}/releases/download/v${_LATEST}/dabcast_${_LATEST}_${_DEB_ARCH}.deb" \
       && [[ "$(dpkg-deb -f "$_DEB" Package 2>/dev/null)" == "dabcast" ]] \
       && [[ "$(dpkg-deb -f "$_DEB" Version 2>/dev/null)" == "$_LATEST" ]]; then
      # SUDO_USER is kept: the package runs the service as the user who started this script
      if dpkg -i "$_DEB"; then
        echo -e "  ${GREEN}✓${NC} DABcast ${_LATEST} installed"
        _DABCAST_OK=true
        [[ -z "$_INSTALLED" ]] && _DABCAST_FIRST=true   # first installation: default sign-in shown below
      else
        echo -e "${YELLOW}⚠ DABcast package installation failed — see the messages above and /var/log/dabcast-install.log${NC}"
      fi
    else
      echo -e "${YELLOW}⚠ DABcast download failed. Install it by hand:${NC}"
      _MANUAL_STEPS
    fi
    rm -rf "$_TMPD"
  fi
fi

_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo -e "${BLUE}========================================${NC}"
if [[ ${#_MISSING[@]} -eq 0 ]]; then
  echo -e "${GREEN}ODR tools installed successfully!${NC}"
else
  echo -e "${RED}Missing required ODR tools: ${_MISSING[*]}${NC}"
  echo -e "${RED}DABcast cannot go on air without them — see the messages above.${NC}"
fi
if [[ "$_DABCAST_OK" == "true" ]]; then
  echo -e "${GREEN}DABcast is installed: open http://${_IP:-<server-ip>}:9090${NC}"
  [[ "${_DABCAST_FIRST:-false}" == "true" ]] && echo "  First sign-in: admin / dabcast — a new password is asked at once."
fi
echo -e "${BLUE}========================================${NC}"
if [[ "$_DABCAST_OK" != "true" && "$TOOLS_ONLY" != "true" && "${_DABCAST_SKIPPED:-false}" != "true" ]]; then
  echo
  echo "Next step: install DABcast"
  _MANUAL_STEPS
fi
if [[ "${_GROUPS_ADDED:-false}" == "true" ]]; then   # only when a group was really added above
  echo
  echo "Note: log out and back in (or reboot) for the new groups of $ACTUAL_USER (SDR / sound card access)."
fi
echo
echo "User guide: https://dabodr.github.io/DABcast-diffusion-software/download/DABcast_Guide.html"
echo
