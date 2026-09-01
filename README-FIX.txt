WhatsApp approvals server - fixed files

Important Render settings:
1) Start Command: npm start
2) Environment:
   SUPABASE_URL=<your project URL>
   SUPABASE_KEY=<server-side Supabase key>
   TARGET_GROUP_NAME=<exact WhatsApp group name> OR TARGET_GROUP_JID=<group jid>
3) For persistent Baileys session on Render paid service:
   Add Persistent Disk mounted at /var/data
   AUTH_DIR=/var/data/auth_info_baileys
4) Health Check Path: /health

Important:
- Free Render web services spin down and do not support persistent disks, so they are not suitable for an always-on WhatsApp listener.
- Do not commit .env or auth_info_baileys to GitHub.
