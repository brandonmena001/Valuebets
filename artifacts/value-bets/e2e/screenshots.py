"""
Capturas a 390 px de ancho + auditoría automática (desborde horizontal, objetivos táctiles < 44 px,
texto < 11 px y contraste aproximado) contra e2e/mock-server.ts. Requiere Playwright para Python.

  python3 artifacts/value-bets/e2e/screenshots.py [carpeta_salida]

El servidor de ejemplo debe estar levantado (puerto 4173 por defecto, variable MOCK_PORT).
"""
import json
import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

PORT = os.environ.get('MOCK_PORT', '4173')
BASE = f'http://localhost:{PORT}'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'e2e-out'
os.makedirs(OUT, exist_ok=True)


def ctl(path: str) -> None:
    urllib.request.urlopen(BASE + path).read()


SLIP_SEED = json.dumps([
    {"id": "f1|1X2|Gana Arsenal", "fixtureId": "f1", "match": "Arsenal vs Chelsea", "market": "1X2", "selection": "Gana Arsenal", "probability": 0.49, "source": "model"},
    {"id": "vb1", "fixtureId": "f2", "match": "Real Madrid vs Sevilla", "market": "Córners totales 9.5", "selection": "Más de 9.5", "probability": 0.58, "source": "blend", "houseOdds": 1.95},
])
HISTORY_SEED = json.dumps([
    {"id": "h1", "savedAt": "2026-10-08T15:00:00.000Z", "selections": [{"match": "Liverpool vs Manchester City", "market": "Goles totales 2.5", "selection": "Más de 2.5", "probability": 0.55}], "houseOdds": 2.1, "stake": 10, "probability": 0.55, "evPct": 15.5, "result": "won", "appliedDelta": 11},
    {"id": "h2", "savedAt": "2026-10-09T18:30:00.000Z", "selections": [{"match": "Arsenal vs Chelsea", "market": "1X2", "selection": "Gana Arsenal", "probability": 0.49}, {"match": "Real Madrid vs Sevilla", "market": "Córners totales 9.5", "selection": "Más de 9.5", "probability": 0.58}], "houseOdds": 3.6, "stake": 5, "probability": 0.284, "evPct": 2.2, "result": "pending", "appliedDelta": 0},
])

AUDIT_JS = r"""
() => {
  const out = { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, small: [], tiny: [], contrast: [] };
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const name = el => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  document.querySelectorAll('a[href], button, input:not([type=hidden]), select, summary, [role=button]').forEach(el => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) out.small.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)} «${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28)}»`);
  });
  const parse = c => { let m = c.match(/rgba?\(([^)]+)\)/); if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = c.match(/color\(srgb ([^)]+)\)/); if (m) { const p = m[1].split(/[ \/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; } return null; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = el => { const layers = []; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    let base = { r: 5, g: 8, b: 6, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim(); const el = node.parentElement;
    if (!text || !el || !visible(el) || ['SCRIPT', 'STYLE'].includes(el.tagName)) continue;
    const s = getComputedStyle(el); const size = parseFloat(s.fontSize);
    if (size < 11) out.tiny.push(`${name(el)} ${size}px «${text.slice(0, 24)}»`);
    const fg = parse(s.color); if (!fg) continue;
    const bg = bgOf(el); const eff = over({ ...fg, a: fg.a * parseFloat(s.opacity) }, bg);
    const l1 = lum(eff), l2 = lum(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) { const key = name(el) + text.slice(0, 20); if (!seen.has(key)) { seen.add(key); out.contrast.push(`${ratio.toFixed(2)} ${name(el)} «${text.slice(0, 28)}»`); } }
  }
  return out;
}
"""

PAGES = [
    # nombre, ruta, texto o selector que confirma que cargó, escenario, acciones previas
    ('01-resumen', '/', '.metric-grid', 'default', {}),
    ('02-partidos', '/matches', '[data-testid=list-matches]', 'default', {}),
    ('03-partido-modelo', '/match/f1', '.fd-hero', 'default', {}),
    ('04-partido-no-existe', '/match/nope', '[data-testid=state-empty]', 'default', {}),
    ('05-cupon', '/slip', '[data-testid=input-house-odds]', 'default', {'slip': True, 'history': True, 'odds': '2.4', 'stake': '10', 'bankroll': '500'}),
    ('06-cupon-vacio-historial', '/slip', '[data-testid=section-history]', 'default', {'history': True}),
    ('07-rendimiento-pequena', '/rendimiento', '[data-testid=perf-reliability]', 'default', {'perf': 'small'}),
    ('08-rendimiento-grande', '/rendimiento', '[data-testid=perf-reliability]', 'default', {'perf': 'large'}),
    ('09-rendimiento-vacio', '/rendimiento', '[data-testid=perf-reliability]', 'default', {'perf': 'empty'}),
    ('10-fuentes-sin-football-data', '/sources', '[data-testid=card-source-football-data]', 'default', {'fd': '0'}),
    ('11-fuentes-con-football-data', '/sources', '[data-testid=card-source-football-data]', 'default', {'fd': '1'}),
    ('12-error-api', '/rendimiento', '[data-testid=status-api-error]', 'error', {}),
    ('13-vacio-resumen', '/', '[data-testid=state-empty]', 'empty', {}),
    ('14-vacio-partidos', '/matches', '[data-testid=state-empty]', 'empty', {}),
    ('15-404', '/ruta-que-no-existe', '[data-testid=page-not-found]', 'default', {}),
]

report = {}
exit_code = 0
with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, path, ready, scenario, opts in PAGES:
        ctl(f'/__scenario?name={scenario}')
        if 'perf' in opts:
            ctl(f"/__set?perf={opts['perf']}")
        if 'fd' in opts:
            ctl(f"/__set?fd={opts['fd']}")
        context = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, locale='es-CO', timezone_id='America/Bogota')
        context.route('**/fonts.googleapis.com/**', lambda route: route.abort())
        context.route('**/fonts.gstatic.com/**', lambda route: route.abort())
        seeds = []
        if opts.get('slip'):
            seeds.append(f"localStorage.setItem('value-bets-slip-v1', {json.dumps(SLIP_SEED)});")
        if opts.get('history'):
            seeds.append(f"localStorage.setItem('value-bets-history-v1', {json.dumps(HISTORY_SEED)});")
        if opts.get('bankroll'):
            seeds.append(f"localStorage.setItem('value-bets-bankroll-v1', '{opts['bankroll']}');")
        if seeds:
            context.add_init_script(';'.join(seeds))
        page = context.new_page()
        problems = []
        page.on('console', lambda m, n=name: problems.append(f'console.{m.type}: {m.text[:160]}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
        page.on('pageerror', lambda e: problems.append(f'pageerror: {str(e)[:160]}'))
        page.goto(BASE + path, wait_until='domcontentloaded')
        try:
            page.wait_for_selector(ready, timeout=15000)
        except Exception as error:  # noqa: BLE001
            problems.append(f'no apareció {ready}: {str(error)[:80]}')
        if opts.get('odds'):
            page.fill('[data-testid=input-house-odds]', opts['odds'])
        if opts.get('stake'):
            page.fill('[data-testid=input-stake]', opts['stake'])
        page.wait_for_timeout(700)
        audit = page.evaluate(AUDIT_JS)
        page.screenshot(path=f'{OUT}/{name}.png', full_page=True)
        report[name] = {'audit': audit, 'problems': problems}
        context.close()
    # Pantalla de carga: la API tarda 6 s y la captura se toma antes
    ctl('/__scenario?name=loading')
    context = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, locale='es-CO')
    context.route('**/fonts.g*apis.com/**', lambda route: route.abort())
    page = context.new_page()
    page.goto(BASE + '/rendimiento', wait_until='domcontentloaded')
    page.wait_for_selector('.skeleton', timeout=10000)
    page.wait_for_timeout(300)
    page.screenshot(path=f'{OUT}/16-cargando-rendimiento.png', full_page=True)
    context.close()
    ctl('/__scenario?name=default')
    browser.close()

for name, data in report.items():
    audit = data['audit']
    flags = []
    if audit['overflow']:
        flags.append(f"DESBORDE horizontal (scrollWidth={audit['scrollWidth']})")
    for key, label in (('small', 'objetivos <44px'), ('tiny', 'texto <11px'), ('contrast', 'contraste bajo')):
        if audit[key]:
            flags.append(f"{label}: {len(audit[key])}")
    print(f"{name}: {'; '.join(flags) if flags else 'OK'}")
    for key in ('small', 'tiny', 'contrast'):
        for item in audit[key][:12]:
            print(f'    [{key}] {item}')
    for problem in data['problems']:
        print(f'    [problema] {problem}')
        exit_code = 1
    if audit['overflow']:
        exit_code = 1
sys.exit(exit_code)
