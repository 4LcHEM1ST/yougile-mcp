# Инструкция по деплою YouGile MCP на удалённый сервер

Эта инструкция описывает развёртывание сервера как **удалённого MCP-сервера через Streamable HTTP**, защищённого **Google OAuth**, с автоматическим TLS-сертификатом от Let's Encrypt (через Caddy).

Рекомендуемый способ — **Docker Compose + Caddy**: он поднимает приложение и обратный прокси с автоматическим получением и продлением публично доверенного TLS-сертификата.

> ⚠️ **Важно:** Claude требует валидный, публично доверенный TLS-сертификат. Самоподписанный сертификат работать не будет. Поэтому нужен реальный домен с DNS, указывающим на сервер.

---

## 1. Что понадобится заранее

| Что | Зачем |
|-----|-------|
| Сервер с публичным IP (Linux, например Ubuntu 22.04+) | Хостинг приложения |
| Доменное имя (например `mcp.example.com`) | Для TLS-сертификата и публичного URL |
| Доступ к DNS домена | Чтобы направить домен на сервер |
| Установленные **Docker** и **Docker Compose v2** | Запуск контейнеров |
| Открытые порты **80** и **443** | HTTP-челлендж ACME + HTTPS |
| Ключ YouGile API (`YOUGILE_API_KEY`) | Общий доступ к YouGile для всех пользователей |
| Google OAuth Client ID (`GOOGLE_CLIENT_ID`) | Проверка токенов входящих пользователей |

---

## 2. Подготовка инфраструктуры

### 2.1. DNS

Создайте `A`-запись (и `AAAA`, если используете IPv6), указывающую ваш домен на публичный IP сервера:

```
mcp.example.com.   A   <PUBLIC_IP_СЕРВЕРА>
```

Дождитесь распространения DNS (проверка: `dig +short mcp.example.com` должен вернуть IP сервера).

### 2.2. Установка Docker (если ещё не установлен)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # затем перелогиньтесь
docker --version
docker compose version
```

### 2.3. Получение YouGile API-ключа

Получите ключ в конфигураторе YouGile или запросом:

```bash
curl -X POST https://yougile.com/api-v2/auth/keys
```

### 2.4. Создание Google OAuth Client ID

1. Откройте [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Создайте **OAuth client ID** (тип — в зависимости от вашего MCP-клиента).
3. Сохраните `Client ID` — он станет значением `GOOGLE_CLIENT_ID`.
   Входящие токены должны иметь этот Client ID в поле `aud` (audience).

---

## 3. Размещение кода на сервере

```bash
git clone <URL_РЕПОЗИТОРИЯ> yougile-mcp
cd yougile-mcp
```

---

## 4. Настройка переменных окружения

Скопируйте пример и заполните значения:

```bash
cp .env.example .env
nano .env
```

Минимально необходимые переменные для Docker Compose:

```bash
# Общий ключ YouGile (все аутентифицированные пользователи работают через него)
YOUGILE_API_KEY=ваш_ключ_yougile

# Google OAuth Client ID — ожидаемый aud входящих токенов
GOOGLE_CLIENT_ID=ваш_google_client_id

# Публичный домен, на который указывает DNS. Caddy получит для него сертификат.
# MCP_PUBLIC_URL выводится автоматически как https://${MCP_DOMAIN}
MCP_DOMAIN=mcp.example.com

# Email для регистрации в Let's Encrypt и уведомлений об истечении срока
ACME_EMAIL=admin@example.com
```

Необязательные ограничения доступа:

```bash
# Разрешить только один домен Google Workspace (claim hd)
# GOOGLE_ALLOWED_DOMAIN=example.com

# Разрешить только перечисленные email (через запятую).
# Пусто = любой подтверждённый Google-аккаунт.
# GOOGLE_ALLOWED_EMAILS=alice@example.com,bob@example.com

# Переопределение базового URL YouGile API (по умолчанию https://yougile.com/api-v2/)
# YOUGILE_API_HOST_URL=https://yougile.com/api-v2/
```

> При деплое через Compose **не нужно** задавать `MCP_PUBLIC_URL` и `MCP_PORT` — они выставляются автоматически (`MCP_PUBLIC_URL=https://${MCP_DOMAIN}`, порт `3000` внутри сети Docker).

---

## 5. Запуск

```bash
docker compose up -d --build
```

Что произойдёт:

- Соберётся образ приложения (multi-stage: сборка TypeScript → runtime на `node:22-alpine`, запуск под пользователем `node`).
- Поднимется контейнер `yougile-mcp` (слушает порт `3000` только внутри сети Docker).
- Поднимется **Caddy**, который займёт порты `80`/`443`, автоматически получит сертификат Let's Encrypt для `${MCP_DOMAIN}` и будет проксировать HTTPS-запросы на приложение.

Проверьте статус и логи:

```bash
docker compose ps
docker compose logs -f caddy        # следите за получением сертификата
docker compose logs -f yougile-mcp
```

---

## 6. Проверка работоспособности

После того как Caddy получит сертификат:

```bash
# Health-check (без авторизации)
curl https://mcp.example.com/healthz
# => {"status":"ok"}

# Метаданные OAuth (RFC 9728, без авторизации)
curl https://mcp.example.com/.well-known/oauth-protected-resource

# MCP-эндпоинт без токена должен вернуть 401 с заголовком WWW-Authenticate
curl -i -X POST https://mcp.example.com/mcp
```

**Доступные эндпоинты:**

| Эндпоинт | Назначение |
|----------|------------|
| `POST /mcp` | Основной MCP-эндпоинт (требует Google Bearer-токен) |
| `GET /.well-known/oauth-protected-resource` | Метаданные OAuth-ресурса |
| `GET /.well-known/oauth-authorization-server` | Редирект на OpenID-конфигурацию Google |
| `GET /healthz` | Health-check |

---

## 7. Подключение MCP-клиента

В клиенте (например Claude) укажите URL удалённого MCP-сервера:

```
https://mcp.example.com/mcp
```

Клиент сам обнаружит способ авторизации через `/.well-known/oauth-protected-resource`, проведёт стандартный поток Google OAuth и будет передавать токен в заголовке `Authorization: Bearer <token>`.

Сервер проверяет токен: ID-токены (JWT) — офлайн по JWKS Google; access-токены — онлайн через `tokeninfo`. В обоих случаях `aud` должен совпадать с `GOOGLE_CLIENT_ID`, email — быть подтверждённым, а ограничения по домену/списку email (если заданы) — выполняться.

---

## 8. Обслуживание

**Обновление до новой версии кода:**

```bash
git pull
docker compose up -d --build
```

**Перезапуск / остановка:**

```bash
docker compose restart
docker compose down            # остановить (сертификаты сохранятся в volume caddy_data)
```

**Просмотр логов:**

```bash
docker compose logs -f
```

Сертификаты и состояние ACME хранятся в Docker volume `caddy_data` и переживают пересборку контейнеров — повторного выпуска сертификата при перезапуске не происходит.

---

## Приложение: запуск без Docker (необязательно)

Если вы предпочитаете запускать процесс напрямую (за собственным TLS-прокси, например nginx):

```bash
npm install
npm run serve:http      # сборка, затем запуск HTTP-сервера
# либо после npm run build:
npm run start:http
```

В этом режиме задайте в `.env`:

```bash
YOUGILE_API_KEY=...
GOOGLE_CLIENT_ID=...
MCP_PUBLIC_URL=https://mcp.example.com   # внешний HTTPS-URL этого сервера
MCP_PORT=3000
```

Приложение слушает обычный HTTP и устанавливает `trust proxy`, поэтому его обязательно нужно разместить за обратным прокси, который терминирует TLS публично доверенным сертификатом. Для автозапуска используйте systemd или PM2.
