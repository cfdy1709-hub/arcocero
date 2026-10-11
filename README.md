# ArcoCero — tienda con inventario real y pagos Wompi

Servidor Node + SQLite que sirve la tienda, controla el stock y cobra con Wompi.

## Cómo abrirla (importante)
**No abras `public/index.html` con doble clic**: la tienda necesita el servidor para cobrar y manejar el stock.
(Si lo haces verás el catálogo en "vista previa", con un aviso rojo, pero no podrás pagar.)

1. Instala [Node.js](https://nodejs.org) 22.13 o superior (una sola vez).
2. Windows: doble clic en `INICIAR.bat`. Mac/Linux: ejecuta `./iniciar.sh`. Se abre http://localhost:3000.

## Probar en tu computador (modo simulado, sin cobro)
```bash
npm install
npm start            # http://localhost:3000
npm test             # 24 pruebas de stock, firmas y webhook
```
Sin llaves de Wompi la tienda corre en **modo simulado**: al pagar aparecen botones para simular
"pago aprobado" o "rechazado". Sirve para ver todo el flujo sin dinero real.

## Cobrar de verdad con Wompi
1. Crea tu comercio en Wompi y entra a *Desarrolladores*. Copia las llaves **de pruebas** al archivo `.env`
   (ver `.env.example`): llave pública, secreto de integridad y secreto de eventos.
2. En Wompi → *Desarrolladores → Seguimiento de transacciones* pon la **URL de eventos**:
   `https://TU-DOMINIO/api/wompi/webhook` (debe ser pública y con HTTPS).
3. Reinicia el servidor. Haz compras de prueba con las tarjetas/cuentas de sandbox de Wompi.
4. Cuando todo funcione, cambia a `WOMPI_ENV=production` y a las llaves de producción (con su propia URL de eventos).

### Cómo funciona el pago
1. El cliente llena sus datos → el servidor **valida, calcula el total con los precios del catálogo y reserva** las unidades (30 min).
2. El servidor firma el monto (firma de integridad) y se abre el widget de Wompi dentro de la página.
3. Wompi cobra y avisa al servidor por **webhook firmado**. El servidor además consulta la transacción a Wompi
   cuando el cliente vuelve a la página; nunca confía en lo que diga el navegador.
4. Aprobado → el stock se descuenta definitivamente. Rechazado/cancelado/vencido → se libera la reserva.

Estados de un pedido: `PENDING`, `PAID`, `FAILED`, `EXPIRED`, `PAID_REVIEW`.
`PAID_REVIEW` = el pago se aprobó cuando la reserva ya había vencido y no quedaban unidades: hay que **reembolsar o reponer** a mano.

## Catálogo, precios e inventario
- Productos, precios y descripciones: `data/catalog.json` (los precios actuales son de ejemplo: ponles los reales).
- `stock` en `catalog.json` solo es el **stock inicial** de productos/tallas nuevos. Después manda la base de datos.
- Para cambiar existencias en marcha (reemplaza TOKEN):
```bash
curl -X POST https://TU-DOMINIO/api/admin/stock -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
     -d '{"productId":"aros","size":"Única","onHand":40}'
curl -H "Authorization: Bearer TOKEN" https://TU-DOMINIO/api/admin/stock          # inventario y reservas
curl -H "Authorization: Bearer TOKEN" "https://TU-DOMINIO/api/admin/orders?status=PAID"   # pedidos pagados
curl -H "Authorization: Bearer TOKEN" "https://TU-DOMINIO/api/admin/orders?status=PAID_REVIEW"
```

## Publicarla
Ya no basta un hosting de archivos estáticos: necesita **Node 22.13 o superior y un disco persistente** para `data/store.db`
(Render, Railway, Fly.io, un VPS…). Ejecuta **una sola instancia**; con SQLite no se debe escalar a varias copias.
Haz copia de seguridad periódica de `data/store.db`. Pon la página detrás de HTTPS (lo exigen Wompi y los navegadores).

## Pendiente / no incluido
- Aviso por correo o WhatsApp al comprador y al vendedor (hoy se consultan los pedidos por el panel `/api/admin`).
- Costo de envío: el total cobrado son solo los productos; el envío se coordina aparte.
- Interfaz gráfica de administración (hoy es por API).
