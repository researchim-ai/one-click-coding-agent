#!/usr/bin/env bash
# Install system dependencies for building Tauri on Ubuntu/Debian.
# Run as: sudo ./install_deps.sh
set -euo pipefail

apt-get update
apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    cmake \
    git \
    pkg-config

echo "✅ All dependencies installed."
