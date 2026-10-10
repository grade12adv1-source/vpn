"""UI checks with a simulated desktop bridge; does not create a VPN tunnel.

Requires Python Playwright and Chromium. Serves only on loopback while testing.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

BRIDGE = r"""
(() => {
  const profiles = [];
  let activeId = null;
  const state = () => ({ profiles: profiles.map(p => ({ ...p })), activeId, busy: false, startedAt: activeId ? Date.now() - 12000 : null, engine: { available: true, platform: 'Windows', instructions: '' } });
  window.testCalls = [];
  window.aero = {
    state: async () => ({ ok: true, data: state() }),
    importProfile: async () => {
      profiles.push({ id: profiles.length ? 'avpn87654321' : 'avpn12345678', name: profiles.length ? 'Nearby' : '<img src=x onerror=alert(1)>', endpoint: 'vpn.example.com:51820', host: 'vpn.example.com', fullTunnel: true, ipv6: false, dnsConfigured: true });
      return { ok: true, data: state() };
    },
    connect: async id => { activeId = id; window.testCalls.push(['connect', id]); return { ok: true, data: state() }; },
    disconnect: async () => { activeId = null; return { ok: true, data: state() }; },
    measure: async () => { profiles.forEach((p, i) => { p.latency = { ms: i ? 14.2 : 45.8, measuredAt: Date.now() }; }); return { ok: true, data: state() }; },
    remove: async id => { profiles.splice(profiles.findIndex(p => p.id === id), 1); return { ok: true, data: state() }; },
    openDocs: async () => ({ ok: true })
  };
})();
"""

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT / 'ui')))
Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True)
        page = browser.new_page(viewport={'width': 1240, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(BRIDGE)
        page.goto(f'http://127.0.0.1:{server.server_port}')
        assert page.locator('#connection-label').inner_text() == 'DISCONNECTED'
        assert page.locator('#metric-latency').inner_text() == '—'
        page.get_by_role('button', name='Import profile', exact=True).first.click()
        page.locator('#profile-count').get_by_text('1', exact=True).wait_for()
        assert page.locator('#route-name').inner_text() == '<img src=x onerror=alert(1)>'
        assert page.locator('#route-name img').count() == 0
        assert page.locator('.coverage-warning').first.inner_text() == 'IPv6 not covered'
        page.get_by_role('button', name='Import profile', exact=True).first.click()
        page.locator('#profile-count').get_by_text('2', exact=True).wait_for()
        page.get_by_role('button', name='Check latency', exact=True).first.click()
        page.locator('#overview-servers .server-latency').first.get_by_text('14.2').wait_for()
        assert page.locator('#overview-servers .server-name').first.inner_text() == 'Nearby'
        page.get_by_role('button', name='Preferences', exact=True).click()
        page.get_by_role('checkbox', name='Prefer the fastest measured endpoint').check()
        assert page.evaluate("localStorage.getItem('aero:fastest')") == 'true'
        page.get_by_role('button', name='Overview', exact=True).click()
        page.get_by_role('button', name='Connect to fastest endpoint', exact=False).click()
        page.locator('#connection-label').get_by_text('TUNNEL ACTIVE', exact=True).wait_for()
        assert page.evaluate('window.testCalls[0][1]') == 'avpn87654321'
        assert page.get_by_role('button', name='Remove Nearby', exact=True).first.is_disabled()
        assert 'not verified' in page.locator('#connection-subtitle').inner_text()
        page.get_by_role('button', name='Disconnect tunnel', exact=False).click()
        page.locator('#connection-label').get_by_text('DISCONNECTED', exact=True).wait_for()
        page.get_by_role('button', name='Remove Nearby', exact=True).first.click()
        page.get_by_role('button', name='Keep profile', exact=True).click()
        assert page.locator('#profile-count').inner_text() == '2'
        page.get_by_role('button', name='Remove Nearby', exact=True).first.click()
        page.get_by_role('button', name='Remove profile', exact=True).click()
        page.locator('#profile-count').get_by_text('1', exact=True).wait_for()
        page.get_by_role('button', name='Setup guide', exact=True).click()
        assert page.locator('h1:visible').inner_text() == 'Three steps to take off.'
        page.get_by_role('button', name='Overview', exact=True).click()
        (ROOT / 'test-results').mkdir(exist_ok=True)
        page.screenshot(path=str(ROOT / 'test-results' / 'with-profile.png'), full_page=True)
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        page.set_viewport_size({'width': 960, 'height': 720})
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        assert not errors, errors
        browser.close()
        print('UI smoke passed: import, safe text rendering, latency sorting, fastest selection, simulated connect/disconnect, removal confirmation, preferences, navigation, and window sizing.')
finally:
    server.shutdown()
    server.server_close()
