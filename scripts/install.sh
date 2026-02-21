#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/claude-a2a"
CONFIG_DIR="/etc/claude-a2a"
DATA_DIR="/var/lib/claude-a2a"
SERVICE_USER="claude-a2a"

echo "=== claude-a2a installer ==="

# Create service user if needed
if ! id "$SERVICE_USER" &>/dev/null; then
    echo "Creating user: $SERVICE_USER"
    useradd --system --shell /usr/sbin/nologin --home-dir "$DATA_DIR" "$SERVICE_USER"
fi

# Create directories
echo "Creating directories..."
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR/workdir"

# Copy application
echo "Installing application..."
cp -r dist/ "$INSTALL_DIR/"
cp -r node_modules/ "$INSTALL_DIR/"
cp package.json "$INSTALL_DIR/"

# Copy config if not exists
if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
    echo "Installing example config..."
    cp config/example.yaml "$CONFIG_DIR/config.yaml"
fi

# Create env file template if not exists
if [ ! -f "$CONFIG_DIR/env" ]; then
    cat > "$CONFIG_DIR/env" << 'EOF'
# claude-a2a environment secrets
# CLAUDE_A2A_MASTER_KEY=your-secret-key-here
# CLAUDE_A2A_JWT_SECRET=your-jwt-secret-here
# LOG_LEVEL=info
EOF
fi

# Set permissions
echo "Setting permissions..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chown -R root:root "$INSTALL_DIR"
chmod 750 "$CONFIG_DIR"
chmod 640 "$CONFIG_DIR/env"

# Install systemd service
echo "Installing systemd service..."
cp systemd/claude-a2a.service /etc/systemd/system/
systemctl daemon-reload

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit /etc/claude-a2a/config.yaml"
echo "  2. Set secrets in /etc/claude-a2a/env"
echo "  3. systemctl enable --now claude-a2a"
echo "  4. Check status: systemctl status claude-a2a"
echo "  5. Check health: curl http://localhost:8462/health"
