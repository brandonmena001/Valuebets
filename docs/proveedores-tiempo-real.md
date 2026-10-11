# Proveedores con cuotas más frescas (investigado, NO implementado)

Todas las cifras vienen de páginas de terceros o de blogs de competidores salvo donde se indica. **Marca: NO verificado en la fuente oficial** salvo lo señalado. Los precios cambian: confirma antes de decidir.

| Proveedor | Frescura | Costo aprox. | Estado |
|---|---|---|---|
| OddsPapi (el actual) | Solo consulta REST en tu plan; su documentación lista WebSocket, pero un blog competidor dice que es solo de nivel empresarial (afirmaciones en conflicto) | Gratis 250 solicitudes/mes según blogs de OddsPapi (tu tope local es 200); planes de pago: precio sin confirmar | Frescura WebSocket: NO verificado |
| The Odds API | Documentación oficial: antes del partido se actualiza cada ~5 min | Gratis 500 créditos; 20K ≈ $30/mes, 100K ≈ $59, 5M ≈ $119 (reseñas, NO verificado en su página). Cada llamada cuesta créditos = mercados x regiones | ~40 casas, sin casas agudas según blogs (NO verificado); mercados de jugador en fútbol: NO verificado |
| SportsGameOdds | Plan gratuito: actualización cada 10 min; Rookie ($99–$149): 3 min; planes altos: menos de 1 min (su página de precios) | $99–$499/mes | Cobertura de fútbol en estas ligas: NO verificado |
| API-Football (ya lo usas) | Odds previas al partido: una actualización diaria recomendada (según su documentación citada por un blog) | Gratis; Pro $19, Ultra $29 (blog, NO verificado) | No sirve para frescura |
| OpticOdds / OddsJam / empresas (Sportradar, LSports) | Marketing: menos de 1 s | Sin precio público; cifras sueltas entre $5 000 y $50 000/mes (NO verificado) | Fuera de alcance |
| Betfair Exchange (mercado, no casa) | NO investigado | NO investigado | Pendiente |

## Lectura para decidir
- Pasar de 200 llamadas/mes a algo útil para errores de minutos exige un plan con **actualización por minutos o transmisión continua**, normalmente de pago (del orden de decenas a cientos de dólares al mes, NO verificado) y hay que confirmar que cubra **mercados de jugador** del fútbol, que es la mayor parte de lo que hoy capturas.
- Antes de pagar, prueba el nivel gratuito del candidato sobre un partido real y mide: casas, mercados de jugador, y con qué frecuencia cambia `changedAt`.
