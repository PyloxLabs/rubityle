#!/bin/bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Rubityle Installer
# Installs the Rubityle game server daemon
# with Docker support on Linux systems
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
PURPLE='\033[0;35m'
RUBY='\033[38;5;197m'
NC='\033[0m'

INSTALL_DIR="/opt/rubityle"
DATA_DIR="/var/lib/rubityle"
LOG_DIR="/var/log/rubityle"
SERVICE_NAME="rubityle"

echo -e "${RUBY}"
echo "  ██████╗ ██╗   ██╗██████╗ ██╗████████╗██╗   ██╗██╗     ███████╗"
echo "  ██╔══██╗██║   ██║██╔══██╗██║╚══██╔══╝╚██╗ ██╔╝██║     ██╔════╝"
echo "  ██████╔╝██║   ██║██████╔╝██║   ██║    ╚████╔╝ ██║     █████╗  "
echo "  ██╔══██╗██║   ██║██╔══██╗██║   ██║     ╚██╔╝  ██║     ██╔══╝  "
echo "  ██║  ██║╚██████╔╝██████╔╝██║   ██║      ██║   ███████╗███████╗"
echo "  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝   ╚═╝      ╚═╝   ╚══════╝╚══════╝"
echo "                         Game Server Daemon Installer"
echo -e "${NC}"

# Check root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] Please run as root (sudo)${NC}"
  exit 1
fi

echo -e "${YELLOW}[1/7] Checking system requirements...${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
  echo -e "${YELLOW}  Docker not found. Installing Docker...${NC}"
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo -e "${GREEN}  Docker installed successfully${NC}"
else
  echo -e "${GREEN}  Docker found: $(docker --version)${NC}"
fi

# Check Docker Compose
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  echo -e "${YELLOW}  Docker Compose not found. Installing...${NC}"
  curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
  chmod +x /usr/local/bin/docker-compose
  echo -e "${GREEN}  Docker Compose installed${NC}"
fi

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}  Node.js not found. Installing...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo -e "${GREEN}  Node.js installed: $(node --version)${NC}"
else
  echo -e "${GREEN}  Node.js found: $(node --version)${NC}"
fi

echo -e "${YELLOW}[2/7] Creating directories...${NC}"
mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"

echo -e "${YELLOW}[3/7] Copying daemon files...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$SCRIPT_DIR" = "$INSTALL_DIR" ]; then
  echo -e "${GREEN}  Already in $INSTALL_DIR, skipping file copy${NC}"
else
  cp "$SCRIPT_DIR/daemon.js" "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/config.js" "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/logger.js" "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/Dockerfile" "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/docker-compose.yml" "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/core" "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/api" "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/sftp" "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/utils" "$INSTALL_DIR/"
fi

echo -e "${YELLOW}[4/7] Installing dependencies...${NC}"
cd "$INSTALL_DIR"
npm install --production

echo -e "${YELLOW}[5/7] Configuring daemon...${NC}"

# Generate random token
DAEMON_TOKEN=$(openssl rand -hex 32)

if [ ! -f "$INSTALL_DIR/.env" ]; then
  cat > "$INSTALL_DIR/.env" << EOF
DAEMON_PORT=8080
DAEMON_TOKEN=$DAEMON_TOKEN
PANEL_URL=http://localhost:7956
PANEL_API_KEY=
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_NETWORK=pylox-servers
DATA_DIR=$DATA_DIR
LOG_DIR=$LOG_DIR
SFTP_PORT=2022
EOF
else
  DAEMON_TOKEN=$(grep DAEMON_TOKEN "$INSTALL_DIR/.env" | cut -d= -f2)
fi

echo -e "${YELLOW}[6/7] Creating systemd service...${NC}"
cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=Rubityle Game Server Daemon
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/daemon.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME
EnvironmentFile=$INSTALL_DIR/.env
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE_NAME
systemctl start $SERVICE_NAME

# Create Docker network
docker network create pylox-servers 2>/dev/null || true

echo -e "${YELLOW}[7/7] Installing rubityle CLI...${NC}"
cat > /usr/local/bin/rubityle << 'CLI_EOF'
#!/bin/bash
# Rubityle Daemon control CLI
SERVICE="rubityle"
RUBY='\033[38;5;197m'
NC='\033[0m'

usage() {
  echo "Usage: rubityle [command]"
  echo ""
  echo "Commands:"
  echo "  (none)    Start the daemon (if needed) and stream its logs."
  echo "            The daemon keeps running if you close this console."
  echo "  start     Start as a background service, enabled at boot (24/7)"
  echo "  stop      Stop the background service"
  echo "  restart   Restart the background service"
  echo "  status    Show background service status"
  echo "  logs      Tail the background service logs (Ctrl+C to exit)"
  echo "  help      Show this help message"
}

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: this command must be run as root (sudo rubityle $1)" >&2
  exit 1
fi

case "$1" in
  ""|run)
    echo " INFO: [$(date '+%b %d %H:%M:%S.%3N')] starting Rubityle daemon"
    echo ""
    echo -e "${RUBY}"
    echo "  ██████╗ ██╗   ██╗██████╗ ██╗████████╗██╗   ██╗██╗     ███████╗"
    echo "  ██╔══██╗██║   ██║██╔══██╗██║╚══██╔══╝╚██╗ ██╔╝██║     ██╔════╝"
    echo "  ██████╔╝██║   ██║██████╔╝██║   ██║    ╚████╔╝ ██║     █████╗  "
    echo "  ██╔══██╗██║   ██║██╔══██╗██║   ██║     ╚██╔╝  ██║     ██╔══╝  "
    echo "  ██║  ██║╚██████╔╝██████╔╝██║   ██║      ██║   ███████╗███████╗"
    echo "  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝   ╚═╝      ╚═╝   ╚══════╝╚══════╝"
    echo ""
    echo "               Rubityle Daemon v2.0.0 | Game Server Daemon"
    echo -e "${NC}"
    echo ""
    systemctl enable "$SERVICE" >/dev/null 2>&1
    systemctl start "$SERVICE"
    if ! systemctl is-active --quiet "$SERVICE"; then
      echo "Failed to start Rubityle daemon. Check: rubityle logs" >&2
      exit 1
    fi
    echo " INFO: [$(date '+%b %d %H:%M:%S.%3N')] daemon running in background, attaching to logs"
    echo " Closing this console keeps the daemon running. Detach with Ctrl+C."
    echo " Stop the daemon with: rubityle stop"
    echo ""
    exec journalctl -u "$SERVICE" -f
    ;;
  start)
    systemctl enable "$SERVICE" >/dev/null 2>&1
    systemctl start "$SERVICE"
    if systemctl is-active --quiet "$SERVICE"; then
      echo "Rubityle daemon started as a background service (enabled at boot)."
      echo "Follow logs with: rubityle logs"
    else
      echo "Failed to start Rubityle daemon. Check: rubityle logs" >&2
      exit 1
    fi
    ;;
  stop)
    systemctl stop "$SERVICE"
    echo "Rubityle daemon stopped."
    ;;
  restart)
    systemctl restart "$SERVICE"
    if systemctl is-active --quiet "$SERVICE"; then
      echo "Rubityle daemon restarted."
    else
      echo "Failed to restart Rubityle daemon. Check: rubityle logs" >&2
      exit 1
    fi
    ;;
  status)
    systemctl status "$SERVICE"
    ;;
  logs)
    journalctl -u "$SERVICE" -f
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $1" >&2
    echo ""
    usage
    exit 1
    ;;
esac
CLI_EOF
chmod +x /usr/local/bin/rubityle

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Rubityle installed successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Install directory: ${YELLOW}$INSTALL_DIR${NC}"
echo -e "  Data directory:    ${YELLOW}$DATA_DIR${NC}"
echo -e "  Log directory:     ${YELLOW}$LOG_DIR${NC}"
echo -e "  Daemon token:      ${YELLOW}$DAEMON_TOKEN${NC}"
echo -e "  Listen port:       ${YELLOW}8080${NC}"
echo ""
echo -e "  ${PURPLE}Service commands:${NC}"
echo -e "    sudo rubityle           ${YELLOW}# start + stream logs (survives console close)${NC}"
echo -e "    sudo rubityle start     ${YELLOW}# run 24/7 as a background service${NC}"
echo -e "    sudo rubityle stop"
echo -e "    sudo rubityle restart"
echo -e "    sudo rubityle status"
echo -e "    sudo rubityle logs"
echo ""
echo -e "  ${PURPLE}Add this node in Panel Admin:${NC}"
echo -e "    FQDN: your-server-ip:8080"
echo -e "    Token: $DAEMON_TOKEN"
echo ""
echo -e "  ${YELLOW}Edit $INSTALL_DIR/.env to configure the panel URL${NC}"
echo ""