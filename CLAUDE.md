# Factoring Service — SUNAT SIRE

Servicio serverless (AWS Lambda + API Gateway) que permite al área comercial consultar facturas de venta aceptadas de posibles clientes para evaluación de factoring, integrando con la API REST SIRE de SUNAT (Perú).

## Stack

- **Runtime**: Node.js 20.x + TypeScript
- **IaC**: AWS SAM (`template.yaml`)
- **AWS**: Lambda, API Gateway, DynamoDB, Secrets Manager, S3, SES

## Comandos

```bash
npm run build        # Compilar TypeScript → dist/
npx tsc --noEmit     # Type check sin emitir
sam deploy --guided  # Primer despliegue (configura stack interactivamente)
sam deploy           # Despliegues posteriores
```

## Estructura

```
src/
├── handlers/          # Un archivo por Lambda
├── services/          # dynamodb.ts, secrets.ts, sunat-auth.ts, sunat-sire.ts, ses.ts
└── utils/             # logger.ts (redacta campos sensibles), validation.ts
template.yaml          # SAM: Lambdas, API Gateway, DynamoDB, S3
```

## Endpoints

| Método | Path | Lambda | Descripción |
|---|---|---|---|
| POST | /onboarding | OnboardingCreate | Registra cliente (ruc, company_name, contact_email, sol_username, sol_password) |
| GET | /onboarding/{id}/status | OnboardingStatus | Estado del onboarding |
| POST | /onboarding/{id}/activate | OnboardingActivate | Equipo sube client_id + client_secret tras registro en portal SUNAT |
| GET | /clients/{ruc}/invoices?period=YYYYMM | InvoiceQuery | Facturas aceptadas (usa cache DynamoDB si existe) |
| GET | /clients/{ruc}/invoices/sync?period=YYYYMM | InvoiceForceSync | Igual pero ignora cache, consulta SUNAT directo |

## Tablas DynamoDB

- `factoring-clients-{env}` — PK: `ruc`, GSI: `onboarding_id-index`
- `factoring-tokens-cache-{env}` — PK: `ruc`, TTL: 55 min
- `factoring-invoices-cache-{env}` — PK: `ruc_period` (`{ruc}#{YYYYMM}`), TTL: 24h

## Credenciales SUNAT

Almacenadas en Secrets Manager bajo `sunat/{ruc}/credentials`:
```json
{ "sol_username": "...", "sol_password": "...", "client_id": "...", "client_secret": "..." }
```
`client_id`/`client_secret` se agregan en el paso de activación (POST /onboarding/{id}/activate).

## Flujo SIRE (asíncrono — 3 pasos obligatorios)

1. POST → crear solicitud → obtener `numTicket`
2. GET polling cada 3s (máx 30 intentos) → esperar `estado = "Atendido"`
3. GET descarga → ZIP → descomprimir → parsear JSON → filtrar tipo=`01` y `estado=0` (aceptadas)

El ZIP descargado se guarda en S3 (`sire-downloads/{ruc}/{period}/{ticket}.zip`) como respaldo.

## Convenciones

- Todos los nombres de campos, variables y rutas en **inglés**
- El `logger` de `src/utils/logger.ts` redacta automáticamente campos sensibles (`sol_password`, `client_secret`, `access_token`, `sol_username`) — siempre usarlo en lugar de `console.log`
- Validación de RUC incluye algoritmo de dígito verificador peruano (`src/utils/validation.ts`)
- Sin auth en esta iteración (Hito 2)

## Despliegue inicial

1. Verificar el email de notificación en SES (Amazon SES → Verified identities)
2. `npm run build`
3. `sam deploy --guided` — ingresar `NotificationEmail` y `Environment` (dev/prod)
