#!/bin/sh
set -eu
state="$1/cloud-desktop"
display="$2"
case "$display" in :[0-9]|:[0-9][0-9]|:[0-9][0-9][0-9]) ;; *) echo "Invalid cloud display" >&2; exit 1 ;; esac
command -v chromium >/dev/null
command -v Xvfb >/dev/null
# OCI-to-VM conversion does not preserve default ACLs. Reapply the desktop
# image's shared-folder policy before launching apps or accepting uploads.
if [ -f /usr/local/share/openwork-desktop/configure-files.sh ]; then
  bash /usr/local/share/openwork-desktop/configure-files.sh
fi
mkdir -p "$state"
chmod 0700 "$state"
chown -R openwork-browser:openwork-browser "$state"
export DISPLAY="$display" XAUTHORITY="$state/.Xauthority"
as_browser() {
  # The desktop must not inherit the worker's host, model or activity tokens.
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/openwork-browser \
    USER=openwork-browser LOGNAME=openwork-browser LANG=C.UTF-8 \
    DISPLAY="$display" XAUTHORITY="$XAUTHORITY" LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe runuser -u openwork-browser -- "$@"
}
as_app() {
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/openwork-app \
    USER=openwork-app LOGNAME=openwork-app LANG=C.UTF-8 \
    DISPLAY="$display" XAUTHORITY=/home/openwork-app/.Xauthority LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe runuser -u openwork-app -- "$@"
}
# Agent-driven pages cannot reach private networks. Native apps cannot open
# network connections at all; the browser's CDP and VNC replies still work.
guard_desktop_egress() {
  uid=$(id -u openwork-browser)
  tools=iptables
  if command -v ip6tables >/dev/null && ip6tables -w -S OUTPUT >/dev/null 2>&1; then tools="iptables ip6tables"; fi
  if id openwork-app >/dev/null 2>&1 && [ -s /proc/net/if_inet6 ]; then
    case " $tools " in *" ip6tables "*) ;; *) echo "The app network guard needs IPv6 filtering" >&2; exit 1 ;; esac
  fi
  for tool in $tools; do
    # The model's shell has public networking, but cannot bypass the guest's
    # authorization via local CDP, VNC or guest-control listeners.
    if id openwork-command >/dev/null 2>&1; then
      command_uid=$(id -u openwork-command)
      "$tool" -w -C OUTPUT -m owner --uid-owner "$command_uid" -m addrtype --dst-type LOCAL -p tcp -m multiport --dports 5900:5903,6080,9222 -j REJECT 2>/dev/null \
        || "$tool" -w -I OUTPUT 1 -m owner --uid-owner "$command_uid" -m addrtype --dst-type LOCAL -p tcp -m multiport --dports 5900:5903,6080,9222 -j REJECT
    fi
    # Native app code (including Blender Python and visible terminals) has no
    # network access. Its Unix-domain app bridges and X display still work.
    if id openwork-app >/dev/null 2>&1; then
      app_uid=$(id -u openwork-app)
      "$tool" -w -C OUTPUT -m owner --uid-owner "$app_uid" -j REJECT 2>/dev/null \
        || "$tool" -w -I OUTPUT 1 -m owner --uid-owner "$app_uid" -j REJECT
    fi
    "$tool" -w -N OPENWORK_DESKTOP_EGRESS 2>/dev/null || "$tool" -w -F OPENWORK_DESKTOP_EGRESS
    "$tool" -w -C OUTPUT -m owner --uid-owner "$uid" -j OPENWORK_DESKTOP_EGRESS 2>/dev/null \
      || "$tool" -w -I OUTPUT 1 -m owner --uid-owner "$uid" -j OPENWORK_DESKTOP_EGRESS
    "$tool" -w -A OPENWORK_DESKTOP_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  done
  for nameserver in $(awk '/^nameserver/ { print $2 }' /etc/resolv.conf); do
    nameserver=${nameserver%%%*}
    case "$nameserver" in *:*) tool=ip6tables ;; *) tool=iptables ;; esac
    case " $tools " in *" $tool "*) ;; *) continue ;; esac
    for protocol in udp tcp; do "$tool" -w -A OPENWORK_DESKTOP_EGRESS -d "$nameserver" -p "$protocol" --dport 53 -j RETURN; done
  done
  for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
    iptables -w -A OPENWORK_DESKTOP_EGRESS -d "$range" -j REJECT
  done
  case " $tools " in *" ip6tables "*)
    # Match the browser policy, including IPv4-compatible/mapped and NAT64.
    for range in ::/96 ::ffff:0:0/96 64:ff9b::/96 64:ff9b:1::/48 fc00::/7 fe80::/10; do ip6tables -w -A OPENWORK_DESKTOP_EGRESS -d "$range" -j REJECT; done ;;
  esac
}
command -v iptables >/dev/null || { echo "The desktop network guard needs iptables" >&2; exit 1; }
guard_desktop_egress
umask 077
if [ ! -s "$XAUTHORITY" ]; then
  touch "$XAUTHORITY"
  chmod 0600 "$XAUTHORITY"
  xauth -f "$XAUTHORITY" add "$display" . "$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  chown openwork-browser:openwork-browser "$XAUTHORITY"
fi
if ! xdotool getdisplaygeometry >/dev/null 2>&1; then
  as_browser setsid -f Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp -auth "$XAUTHORITY" >"$state/display.log" 2>&1 < /dev/null
fi
attempt=0
until xdotool getdisplaygeometry >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || { echo "Cloud display did not start" >&2; exit 1; }
  sleep 0.1
done
if id openwork-app >/dev/null 2>&1; then
  # Share display access, never the Chromium profile or browser home. The
  # window manager launches menu/taskbar apps under the same isolated account.
  install -o openwork-app -g openwork-app -m 0600 "$XAUTHORITY" /home/openwork-app/.Xauthority
fi
if ! xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; then
  if id openwork-app >/dev/null 2>&1; then
    as_app setsid -f openbox >"$state/window-manager.log" 2>&1 < /dev/null
  else
    as_browser setsid -f openbox >"$state/window-manager.log" 2>&1 < /dev/null
  fi
fi
# A taskbar and Applications menu are installed by the Workbot desktop image.
# Older snapshots still open their browser without claiming extra apps exist.
if command -v tint2 >/dev/null; then
  if id openwork-app >/dev/null 2>&1; then
    if ! pgrep -u openwork-app -x tint2 >/dev/null; then as_app setsid -f tint2 >"$state/taskbar.log" 2>&1 < /dev/null; fi
  elif ! pgrep -u openwork-browser -x tint2 >/dev/null; then
    as_browser setsid -f tint2 >"$state/taskbar.log" 2>&1 < /dev/null
  fi
fi
if ! curl --fail --silent --max-time 2 http://127.0.0.1:9222/json/version >/dev/null; then
  # The browser runs as an unprivileged user with Chromium's sandbox enabled.
  as_browser setsid -f chromium --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
    --user-data-dir="$state/profile" --window-size=1280,800 --force-device-scale-factor=1 --no-first-run \
    --no-default-browser-check about:blank >"$state/browser.log" 2>&1 < /dev/null
fi
attempt=0
until curl --fail --silent --max-time 2 http://127.0.0.1:9222/json/version >/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || { echo "Cloud browser did not start" >&2; exit 1; }
  sleep 0.2
done
if [ "${WORKBOT_DESKTOP_VNC:-0}" = 1 ]; then
  command -v x11vnc >/dev/null
  window=$(xdotool search --onlyvisible --class chromium | head -n 1)
  [ -n "$window" ] || { echo "The browser window is unavailable" >&2; exit 1; }
  # Root's guest starts one inetd-mode viewer over private stdio. A process
  # binding a local VNC port can never substitute itself for that transport.
  printf '%s\n' "$window" > "$1/browser-window"
fi
