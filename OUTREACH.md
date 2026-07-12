# MCP-Shield — Outreach Tracker 📣

> Estado vivo del lanzamiento. Actualizar tras cada acción. Última actualización: 2026-07-12.

## ⚠️ Datos canónicos (NO equivocarse)

| Dato | Valor correcto |
|------|----------------|
| Paquete npm | `@jrooig/mcpshield` (**v0.1.5**, latest — publicada 2026-07-12, añade soporte Codex CLI) |
| Install | `npm install -g @jrooig/mcpshield` |
| Comando CLI (bin) | `mcp-shield ...` (soporta `--help`/`-h` y `--version`/`-v`) |
| Repo GitHub | https://github.com/jaumerohi2007-cell/mcp-shield |
| Página npm | https://www.npmjs.com/package/@jrooig/mcpshield |

**Colisión de nombre:** `mcp-shield` (sin scope) en npm y `github.com/riseandignite/mcp-shield`
pertenecen a OTRA persona (Nikita / riseandignite) — es otro tool de seguridad MCP con el
mismo nombre. NUNCA promocionar `npm install -g mcp-shield` (instala el del competidor).
**Decisión (2026-07-11): IGNORAR por ahora** — se lanza con `@jrooig/mcpshield` y enlace
directo al repo/npm; no se rebrandea. Revisitar si hay confusión real de usuarios.

## 📌 Publicación / entrega (release)

Cuenta npm `jrooig` usa **security key (WebAuthn)** como 2FA, NO app de códigos TOTP.
Consecuencias para republicar:
- `npm publish` con `--otp=<código>` NO sirve (no hay códigos con security key).
- npm 9.2.0 (instalado) es demasiado viejo para el flujo WebAuthn-por-navegador en publish.
- **Método que funciona:** Access Token tipo **Automation** (o Granular con Read+Write) +
  `.npmrc` temporal → `npm publish --access public --userconfig <tmp>` → borrar el .npmrc.
  Revocar el token tras publicar. (Los tokens que saltan 2FA se restringen en **ene-2027**.)
- Alternativa futura: actualizar a npm ≥10 para usar `--auth-type=web` en el publish.

## 🚦 Estado por canal

| Canal | Estado | Fecha | URL del post | Notas |
|-------|--------|-------|--------------|-------|
| Hacker News (Show HN) | 🗓️ Agendado | **Mar 14 jul ~15:00 UTC / 17:00 ES** | — | Estar disponible 3-4h para responder |
| Reddit r/selfhosted | ⬜ Pendiente | — | — | Revisar reglas de self-promo del sub |
| Reddit r/node | ⚠️ Publicado con ERROR | ~6 jul | reddit.com/r/node/comments/1un3sxx | Install ROTO (`npm i -g mcp-shield` = competidor). 5.1K views, 3 up. Top comment escéptico (tj-horner). Decisión 12 jul: EDITAR install+copy y responder |
| Reddit r/ArtificialIntelligence | ⬜ Pendiente | — | — | |
| X / Twitter (hilo) | ⬜ Pendiente | — | — | Hilo 5 tweets + captura/vídeo en tweet 1 |
| Vídeo demo (~90s) | ⬜ Por grabar | — | — | Guion en LAUNCH.md §4. Para X y hero del README |
| Product Hunt | ⬜ No planificado | — | — | Opcional, requiere assets |
| Newsletters/comunidades AI-sec | ⬜ Pendiente | — | — | Ver lista de targets abajo |

Leyenda: ⬜ Pendiente · 🟡 En progreso · ✅ Publicado · 💬 Con respuestas

## 🗓️ Secuencia recomendada

1. **Pre-flight** (antes de postear nada):
   - [x] Screenshot del dashboard listo (modal Manual authorization + cola). ✅ 2026-07-11
         Método fiable: `node demo/populate-dashboard.cjs` puebla el dashboard en :3020.
   - [x] README con badge/install corregidos y pusheado a GitHub. ✅ 2026-07-11
   - [x] `--help`/`--version` funcionan (v0.1.2 publicada). ✅ 2026-07-11
   - [x] `npm install -g @jrooig/mcpshield` probado en limpio (WSL, prefix aislado). ✅ 2026-07-12
         Verificado sobre el paquete publicado: `--version`=0.1.3, `--help` OK, `public/**`
         viaja en el tarball, dashboard sirve `/` con HTTP 200 (5141 B) + app.js/app.css 200.
         Confirma que el bug de v0.1.1 (`Cannot GET /`) está arreglado en producción.
   - [x] Elegir día/hora del Show HN → **martes 14 jul ~15:00 UTC / 17:00 ES**. ✅ 2026-07-11
   - [ ] Estar disponible ~3-4h tras postear para responder comentarios.

### Cómo hacer la captura del dashboard
El dashboard vacío no vende; hay que capturarlo con tráfico real retenido:
1. `mcp-shield install cursor` (o el cliente que uses) para enrutar un server real por el shield.
2. Abrir `http://localhost:3000`.
3. Pedir al agente algo que dispare reglas: un `curl https://example.com` (→ estado ASK) y un
   `rm -rf ./tmp` (→ BLOCK). Así la cola muestra ASK + BLOCK a la vez.
4. Capturar con el panel de **aprobar / denegar / editar argumentos** visible.
2. **Día 1** — Show HN (único disparo, alta señal). Responder cada comentario rápido.
3. **Día 1-2** — Hilo en X reusando tracción de HN.
4. **Día 2-3** — Reddit (1 sub por día para no quemar; adaptar tono a cada comunidad).
5. **Semana 1-2** — Outreach directo a newsletters/comunidades AI-security.

## 🎯 Targets de outreach directo

### Tier 1 — Autoridades en prompt injection / AI security (máximo encaje)
Son quienes escriben sobre exactamente este problema. Un writeup suyo vale más que 100 upvotes.
- [ ] **Simon Willison** (simonwillison.net, @simonw) — el mayor divulgador de prompt injection.
      Cubre herramientas así en su blog/newsletter. Email corto y honesto, sin hype.
- [ ] **Johann Rehberger** (embracethered.com, @wunderwuzzi23) — AI red-teamer, experto en
      indirect prompt injection. Muy probable interés técnico en el enforcement a nivel wire.
- [ ] **tl;dr sec** (Clint Gibler, @clintgibler) — newsletter de seguridad enorme con sección
      LLM/AI. Enviar el tool para que lo linkee.
- [ ] **Kai Greshake / Rich Harang** — investigadores de indirect prompt injection.

### Tier 2 — Ecosistema MCP: aparecer en directorios y listas (alto ROI, bajo esfuerzo)
Que la gente que ya busca herramientas MCP te encuentre.
- [ ] **Discord oficial de MCP** + GitHub Discussions de `modelcontextprotocol`.
- [ ] Listas **awesome-mcp** (p.ej. `punkpeye/awesome-mcp-servers`) — abrir PR para listarse.
- [ ] Directorios: **Glama.ai**, **mcp.so**, **Smithery.ai**, **PulseMCP** — dar de alta el server.
- [ ] Subreddits: **r/mcp**, **r/ClaudeAI**, **r/cursor**, **r/LocalLLaMA**.

### Tier 3 — Newsletters/aggregators dev & AI (volumen)
- [ ] **Lobste.rs** (tags security/ai) — postear como en HN (necesita invitación al sitio).
- [ ] **Latent Space** (swyx) — newsletter/podcast/Discord de AI engineering.
- [ ] **Return on Security** (Mike Privette) — newsletter de negocio de seguridad.
- [ ] **TLDR AI / Ben's Bites / The Rundown** — newsletters AI generalistas (encaje medio).

### Tier 4 — Comunidades para conversación directa
- [ ] **Foro/Discord de Cursor**, **Discord de Anthropic**, comunidades de Claude Code.

### Plantilla de email/DM en frío (breve)
> Asunto: Local firewall for MCP tool calls (prompt-injection defense)
>
> Hi <nombre> — I built MCP-Shield, an inline stdio proxy that enforces policy on MCP
> tool calls (block rm -rf, hold curl/out-of-workspace writes for manual approval,
> NFKC-normalize tool outputs to catch obfuscated injection). It's local-only, no telemetry.
> Given your work on <tema concreto suyo>, thought it might interest you.
> Repo: github.com/jaumerohi2007-cell/mcp-shield — happy to hear where you think it breaks.

**Regla de oro:** personalizar la primera línea con algo concreto que ESA persona escribió.
Nada de copiar-pegar genérico a Tier 1 — se nota y quema el contacto.

## ⚠️ Riesgos / decisiones abiertas

- **Nombre colisiona** con otro `mcp-shield` en npm y GitHub. **Decisión: ignorar por ahora**
  (ver "Datos canónicos"). Revisitar solo si aparece confusión real de usuarios.
- **UX menor pendiente:** el dashboard se cierra si se prueba el comando de ejemplo suelto
  (sin cliente MCP conectado). No es bug en uso real, pero puede confundir a quien "solo prueba".

## 📝 Log de cambios

**2026-07-12** — Pre-flight (2 días antes del Show HN):
- Smoke test del install limpio en WSL sobre un prefix aislado (`npm install -g` a
  `$TMP/npm-global`, sin tocar el global real). Todo verde: `--version`=0.1.3,
  `--help` con install/bin correctos, `public/**` presente en el tarball, dashboard
  sirve `/` con HTTP 200 (5141 B) y `app.js`/`app.css` a 200. Confirma en producción el
  fix del bug `Cannot GET /` de v0.1.1. Checkbox de pre-flight tachado.
- E2E de enforcement contra el binario instalado desde npm: `ls -la` se reenvía (ALLOW),
  `rm -rf` se bloquea con `Access Denied by Policy` sin llegar al target. ✅
- **🐛 BUG DE LANZAMIENTO ENCONTRADO Y ARREGLADO** — `install`/`uninstall` sobre el
  paquete de npm: el detector `invokesShield` (src/install.ts) solo reconocía rutas con el
  segmento `mcp-shield` (con guion), pero el paquete publicado se instala en
  `@jrooig/mcpshield` (**sin guion**). Efecto en un install real de npm: `install` corrido
  dos veces DOBLE-ENVOLVÍA el server, y `uninstall` decía "No servers were protected" y
  NO revertía nada → usuario atrapado con la config modificada. Los 81 tests no lo pillaban
  porque corren desde el checkout, cuyo dir SÍ se llama `mcp-shield`.
  - Fix: `invokesShield` reconoce ahora `mcp-shield` Y `mcpshield` (case-insensitive) vía
    `SHIELD_DIR_SEGMENTS`. Verificado end-to-end empaquetando con `npm pack` e instalando el
    tarball (layout idéntico a npm): install idempotente ("already protected"), uninstall
    restaura exacto, round-trip OK, remote-http intacto.
  - Añadidos 2 tests de regresión en `tests/install.test.mjs` (entrada envuelta con ruta
    estilo npm sin guion). Probado que FALLAN sin el fix y PASAN con él. Suite: **83/83**.
  - **v0.1.4 PUBLICADA en npm** (2026-07-12, Automation token + `.npmrc` temporal). Verificado
    en producción: install limpio de `@jrooig/mcpshield@0.1.4`, `install` idempotente,
    `uninstall` restaura exacto (round-trip ✅). Commits `e820a46` (fix+tests) y `62fdf85`
    (docs) + tag `v0.1.4` en local (⚠️ falta `git push` al repo de GitHub).
- **Soporte Codex CLI añadido** (pregunta del padre del user): `mcp-shield install codex` +
  auto-detect. Codex usa TOML (`~/.codex/config.toml`, `$CODEX_HOME`) → editor quirúrgico por
  líneas que preserva comentarios/keys ajenas byte a byte. Verificado contra tarball npm
  (round-trip exacto). Suite 88/88. Commit `bb92761`, tag `v0.1.5`. **v0.1.5 PUBLICADA en npm
  y pusheada a GitHub** (2026-07-12 tarde); verificada en producción: `--help` lista codex,
  round-trip byte a byte sobre install limpio del registry. Token revocado tras publicar.
- **Landing:** añadida línea "Claude Code ready — run: mcp-shield install claude-code" al
  terminal del hero (mcp-shield-landing/src/components/Hero.tsx) — Claude Code no salía
  porque el barrido auto solo muestra los autoDetect; decisión: línea explícita honesta.
- Pendiente para el martes: **grabar el vídeo demo** (~90s, LAUNCH.md §4) y postear el Show HN.

**2026-07-11** — Sesión de arranque del outreach:
- Fix crítico: todas las plantillas y el README apuntaban a `mcp-shield` (paquete de otra
  persona); corregido a `@jrooig/mcpshield`. Commit `f5a5f89`.
- Show HN reescrito: título más concreto, install correcto, párrafo honesto de threat-model.
  Commit `ebcf527`.
- Feature: `mcp-shield --help`/`-h` y `--version`/`-v` (antes fallaban). Commit `016a861`.
- Publicada **v0.1.2** en npm (81 tests en verde). Tag `v0.1.2` pusheado.
- Decisión de nombre: ignorar la colisión por ahora.
- Creados este tracker + memoria de proyecto.
- **Bug crítico de release encontrado y arreglado:** el campo `files` de package.json
  omitía `public/`, así que el paquete publicado no llevaba la UI del dashboard →
  `Cannot GET /` para todo el que instalara. Añadido `public/**`, publicada **v0.1.3**.
  (Detectado al montar la demo con Claude Desktop.) Commit del fix + tag `v0.1.3`.
- Creado `demo/mcp-demo-server.cjs`: mini server MCP (handshake correcto) que anuncia
  `run_command`/`write_file` para generar ASK/BLOCK en la captura. NO se publica en npm.
- Corregida la config de Claude Desktop del usuario (JSON inválido por bloque duplicado +
  colisión de puerto). `shield-demo` ahora en puerto **3010**. Backup: `*.bak-20260711`.
- Captura de lanzamiento conseguida vía `demo/populate-dashboard.cjs` (puebla el dashboard
  en :3020 con 1 allow + 1 block + 1 ask). Modal "Manual authorization" = money shot.
- Pulidos los textos de **X (hilo de 5 tweets)** y **Reddit** en LAUNCH.md: fuera jerga
  "premium/glassmorphic", añadido alcance honesto, install correcto.
