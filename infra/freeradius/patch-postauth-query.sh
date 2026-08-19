#!/bin/sh
# Replace the default post-auth INSERT so radpostauth stores MAC + reject reason.
set -e
TARGET=/etc/raddb/mods-config/sql/main/postgresql/queries.conf
TMP=/tmp/queries.conf.new

awk '
BEGIN { skip = 0 }
/^post-auth \{/ {
  skip = 1
  print "post-auth {"
  print "\tquery = \"\\"
  print "\t\tINSERT INTO ${..postauth_table} \\"
  print "\t\t\t(username, pass, reply, authdate, callingstationid, calledstationid, class) \\"
  print "\t\tVALUES ( \\"
  print "\t\t\t'\''%{SQL-User-Name}'\'', \\"
  print "\t\t\t'\'''\'', \\"
  print "\t\t\t'\''%{reply:Packet-Type}'\'', \\"
  print "\t\t\tNOW(), \\"
  print "\t\t\tNULLIF('\''%{outer.request:Calling-Station-Id}'\'', '\'''\''), \\"
  print "\t\t\tNULLIF('\''%{outer.request:Called-Station-Id}'\'', '\'''\''), \\"
  print "\t\t\tCOALESCE(NULLIF('\''%{control:Tmp-String-1}'\'', '\'''\''), NULLIF('\''%{reply:Class}'\'', '\'''\''), NULLIF('\''%{session-state:Class}'\'', '\'''\''), NULLIF('\''%{outer.session-state:Class}'\'', '\'''\'')) \\"
  print "\t\t)\""
  print "}"
  next
}
skip {
  if (/^\}/) skip = 0
  next
}
{ print }
' "$TARGET" > "$TMP"
mv "$TMP" "$TARGET"
