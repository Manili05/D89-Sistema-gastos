# Restaurar servicios deshabilitados durante la preparación de D89

Ejecutar solo si se decide revertir la dedicación del VPS a D89:

```bash
docker start backend-insforge-1 backend-postgrest-1 backend-deno-1 backend-postgres-1
docker start insforge-main-insforge-1 insforge-main-deno-1 insforge-main-postgrest-1 insforge-main-postgres-1
docker start vibevoice-asr vibevoice-tts drawdb openclaw-gw-bridge
systemctl --user enable --now hermes-gateway.service insforge-ngrok.service openclaw-gateway.service
ln -s /etc/nginx/sites-available/appinmobilaria-review /etc/nginx/sites-enabled/appinmobilaria-review
nginx -t && systemctl reload nginx
```

Appinmobilaria no tenía una unidad administrada: se iniciaba con Astro desde
`/root/appinmobilaria`. Debe levantarse con el comando documentado por ese
proyecto si se requiere recuperarla.
