# Инструкция по деплою YouGile MCP на удалённый сервер

Эта инструкция описывает развёртывание сервера как **удалённого MCP-сервера через Streamable HTTP** с полноценным **Google OAuth 2.0 Authorization Code Flow** и автоматическим TLS-сертификатом от Let's Encrypt (через Caddy).

Рекомендуемый способ — **Docker Compose + Caddy**: он поднимает приложение и обратный прокси с автоматическим получением и продлением публично доверенного TLS-сертификата.

> **Важно:** Claude требует валидный, публично доверенный TLS-сертификат. Самоподписанный сертификат работать не будет. Поэтому нужен реальный домен с DNS, указывающим на сервер.

---

## Как работает OAuth

Сервер выступает полноценным **OAuth 2.0 Authorization Server** для Claude, используя Google лишь для аутентификации реального пользователя:

1. Claude обнаруживает сервер авторизации через `/.well-known/oauth-authorization-server`.
2. Claude динамически регистрируется (RFC 7591) на `/register`.
3. Claude перенаправляет пользователя на `/authorize` → сервер редиректит в Google.
4. Пользователь входит через Google, Google возвращает код на `/auth/callback`.
5. Сервер обменивает код на Google id_token, извлекает email, проверяет список разрешённых.
6. Сервер выдаёт **собственный** access + refresh токены Claude.
7. Claude обращается к MCP-эндпоинту (`POST /`) с `Authorization: Bearer <token>`.
8. Refresh-токен действует 30 дней; access-токен — 60 минут и обновляется автоматически.

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
| Google OAuth **Client ID** и **Client Secret** | Authorization Code Flow |

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

Получите ключ в конфигураторе YouGile (`Ctrl + ~`) или запросом:

```bash
curl -X POST https://yougile.com/api-v2/auth/keys \
  -H "Content-Type: application/json" \
  -d '{"login":"email@example.com","password":"...","companyId":"..."}'
```

### 2.4. Создание Google OAuth 2.0 Credentials

1. Откройте [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Нажмите **Create Credentials → OAuth client ID**.
3. Тип приложения: **Web application**.
4. В поле **Authorized redirect URIs** добавьте:
   ```
   https://mcp.example.com/auth/callback
   ```
5. Сохраните **Client ID** и **Client Secret** — они потребуются в `.env`.

> Если OAuth consent screen ещё не настроен, Google предложит это сделать перед созданием credentials. Выберите тип **External**, добавьте нужные тестовые email-адреса.

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

# Google OAuth credentials (Web Application)
GOOGLE_CLIENT_ID=ваш_google_client_id
GOOGLE_CLIENT_SECRET=ваш_google_client_secret

# Публичный домен. Caddy получит для него сертификат.
# MCP_PUBLIC_URL выводится автоматически как https://${MCP_DOMAIN}
MCP_DOMAIN=mcp.example.com

# Email для регистрации в Let's Encrypt и уведомлений об истечении срока
ACME_EMAIL=admin@example.com
```

Ограничение доступа (**обязательно** задать хотя бы одно — иначе сервер не запустится):

```bash
# Разрешить только перечисленные email (через запятую)
GOOGLE_ALLOWED_EMAILS=alice@example.com,bob@example.com

# И/или разрешить любой аккаунт из домена Google Workspace (проверяется claim `hd`)
# GOOGLE_ALLOWED_DOMAIN=example.com
```

> Доступ работает по принципу deny-by-default: вход разрешён, только если email есть в
> `GOOGLE_ALLOWED_EMAILS` **или** относится к домену `GOOGLE_ALLOWED_DOMAIN`. Если не задано
> ни то, ни другое, сервер откажется стартовать.

> При деплое через Compose **не нужно** задавать `MCP_PUBLIC_URL` и `MCP_PORT` — они выставляются автоматически (`MCP_PUBLIC_URL=https://${MCP_DOMAIN}`, порт `3000` внутри сети Docker).

---

## 5. Запуск

```bash
docker compose up -d --build
```

Что произойдёт:

- Соберётся образ приложения (multi-stage: сборка TypeScript → runtime на `node:22-alpine`).
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
curl https://mcp.example.com/health
# => {"status":"ok"}

# Метаданные OAuth Authorization Server (без авторизации)
curl https://mcp.example.com/.well-known/oauth-authorization-server

# MCP-эндпоинт без токена должен вернуть 401
curl -i -X POST https://mcp.example.com/
```

**Доступные эндпоинты:**

| Эндпоинт | Назначение |
|----------|------------|
| `POST /` | Основной MCP-эндпоинт (требует Bearer-токен) |
| `GET /.well-known/oauth-authorization-server` | Метаданные OAuth AS |
| `GET /.well-known/oauth-protected-resource` | Метаданные защищённого ресурса |
| `GET /authorize` | Начало OAuth-потока (редирект в Google) |
| `POST /token` | Обмен кода на токены / обновление по refresh |
| `POST /register` | Dynamic Client Registration (RFC 7591) |
| `GET /auth/callback` | Обратный вызов от Google |
| `GET /health` | Health-check |

---

## 7. Подключение к Claude.ai

1. Откройте [claude.ai](https://claude.ai) → Settings → Integrations (или Connectors).
2. Добавьте новый MCP-коннектор с URL:
   ```
   https://mcp.example.com
   ```
3. Claude автоматически обнаружит OAuth-сервер, откроет всплывающее окно для входа через Google.
4. После успешного входа коннектор станет активным и доступны все инструменты YouGile.

> Если вы ограничили доступ через `GOOGLE_ALLOWED_EMAILS` или `GOOGLE_ALLOWED_DOMAIN`, пользователи с неразрешёнными email получат страницу 403.

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

Сертификаты и состояние ACME хранятся в Docker volume `caddy_data` и переживают пересборку контейнеров.

> **Важно:** токены хранятся в памяти процесса. После перезапуска контейнера пользователям потребуется повторный вход — Claude инициирует его автоматически при следующем обращении.

---

## Приложение: запуск без Docker

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
GOOGLE_CLIENT_SECRET=...
MCP_PUBLIC_URL=https://mcp.example.com   # внешний HTTPS-URL
MCP_PORT=3000
# GOOGLE_ALLOWED_EMAILS=...
```

Приложение слушает HTTP и устанавливает `trust proxy`, поэтому его обязательно нужно разместить за обратным прокси, который терминирует TLS. Для автозапуска используйте systemd или PM2.
