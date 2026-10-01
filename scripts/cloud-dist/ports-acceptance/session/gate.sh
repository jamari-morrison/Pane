#!/bin/bash
# Runs IN a Session (read-only): when the daemon started vs when the bootstrap wrote the Session marker.
# daemon_start < marker_mtime means the daemon booted before the marker existed and was not restarted since.
u=pane-remote-daemon.service
ts=$(systemctl --user show -p ActiveEnterTimestamp --value "$u")
echo "daemon_start=$(date -d "$ts" +%s) ($ts) pid=$(systemctl --user show -p MainPID --value "$u")"
echo "marker_mtime=$(stat -c %Y /etc/rp-cloud/serve.json) ($(date -u -d @"$(stat -c %Y /etc/rp-cloud/serve.json)" +%T)Z)"
echo "daemon_restarts=$(systemctl --user show -p NRestarts --value "$u")"
grep -h "now in a Runpane Cloud Session\|Session notes for agents\|ports: opened" "$HOME"/.pane_remote/logs/pane-*.log | head -5
