(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  let state = { profiles: [], activeId: null, busy: false, startedAt: null, engine: { available: false, platform: 'Desktop', instructions: 'Launch the desktop app to check the native WireGuard engine.' } };
  let selectedId = null;
  let operation = false;
  let measuring = false;
  let pendingRemove = null;
  let toastTimer;
  let preferFastest = localStorage.getItem('aero:fastest') === 'true';
  const api = window.aero;

  function notify(message, error = false) {
    clearTimeout(toastTimer);
    const toast = $('#toast');
    toast.querySelector('span').textContent = message;
    toast.classList.toggle('error', error);
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 14000 : 6500);
  }

  async function call(method, ...args) {
    if (!api) throw new Error('Open Aero VPN as a desktop app to import profiles or manage tunnels.');
    const result = await api[method](...args);
    if (!result?.ok) throw new Error(result?.error || 'Operation failed.');
    return result.data;
  }

  function apply(next) {
    state = next;
    if (!state.profiles.some(p => p.id === selectedId)) selectedId = state.activeId || state.profiles[0]?.id || null;
    if (state.activeId) selectedId = state.activeId;
    render();
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function textElement(tag, cls, value) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    node.textContent = value;
    return node;
  }

  function renderServers(container) {
    container.replaceChildren();
    if (!state.profiles.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const mark = textElement('span', 'empty-icon', ''); mark.append(icon('folder'));
      const content = document.createElement('div');
      content.append(textElement('strong', '', 'Your next connection starts here.'), textElement('p', '', 'Import a WireGuard profile from your server or VPN provider.'));
      empty.append(mark, content, icon('upload'));
      container.append(empty);
      return;
    }
    const sorted = [...state.profiles].sort((a, b) => (a.latency?.ms ?? Infinity) - (b.latency?.ms ?? Infinity));
    const fastest = sorted.find(p => Number.isFinite(p.latency?.ms));
    for (const profile of sorted) {
      const row = document.createElement('div'); row.className = 'server-row';
      const select = document.createElement('button');
      select.className = `server-radio${selectedId === profile.id ? ' selected' : ''}`;
      select.setAttribute('aria-label', `Select ${profile.name}`);
      select.setAttribute('aria-pressed', String(selectedId === profile.id));
      select.disabled = operation || !!state.activeId;
      select.addEventListener('click', () => { selectedId = profile.id; render(); });
      const globe = textElement('span', 'server-icon', ''); globe.append(icon('globe'));
      const details = textElement('div', 'server-details', '');
      details.append(textElement('div', 'server-name', profile.name), textElement('div', 'server-endpoint', profile.endpoint));
      if (!profile.fullTunnel || profile.ipv4 === false || !profile.ipv6 || !profile.dnsConfigured) {
        const warnings = [];
        if (!profile.fullTunnel) warnings.push('Split tunnel');
        if (profile.ipv4 === false) warnings.push('IPv4 not covered');
        if (!profile.ipv6) warnings.push('IPv6 not covered');
        if (!profile.dnsConfigured) warnings.push('System DNS');
        details.append(textElement('div', 'coverage-warning', warnings.join(' · ')));
      }
      row.append(select, globe, details);
      if (profile.id === state.activeId) row.append(textElement('span', 'server-badge', 'ACTIVE'));
      else if (profile.id === fastest?.id) row.append(textElement('span', 'server-badge', 'LOWEST RTT'));
      const latency = textElement('span', `server-latency${Number.isFinite(profile.latency?.ms) ? ' measured' : ''}`, Number.isFinite(profile.latency?.ms) ? String(profile.latency.ms) : '—');
      latency.title = profile.latency ? `ICMP endpoint RTT, checked ${new Date(profile.latency.measuredAt).toLocaleTimeString()}. No response may mean ICMP is blocked.` : 'Endpoint latency has not been measured.';
      latency.append(textElement('small', '', 'ms')); row.append(latency);
      const remove = document.createElement('button'); remove.className = 'delete-profile';
      remove.append(icon('trash')); remove.setAttribute('aria-label', `Remove ${profile.name}`);
      remove.disabled = operation || profile.id === state.activeId;
      remove.addEventListener('click', () => { pendingRemove = profile.id; $('#remove-dialog').showModal(); });
      row.append(remove); container.append(row);
    }
  }

  function render() {
    const profile = state.profiles.find(p => p.id === selectedId);
    const active = !!state.activeId;
    const busy = operation || state.busy;
    $('#profile-count').textContent = state.profiles.length;
    $$('.profile-count').forEach(el => el.textContent = state.profiles.length);
    $('#connection-label').textContent = busy ? 'PLEASE WAIT' : active ? 'TUNNEL ACTIVE' : 'DISCONNECTED';
    $('#status-dot').classList.toggle('on', active);
    $('#power-button').classList.toggle('on', active);
    $('#power-button').classList.toggle('busy', busy);
    $('#power-button').disabled = busy || (!active && (!profile || !state.engine.available));
    $('#power-button').setAttribute('aria-label', active ? 'Disconnect VPN' : 'Connect VPN');
    $('#connection-title').textContent = active ? 'Your tunnel is running.' : profile ? 'Ready when you are.' : 'A connection of your own.';
    $('#connection-subtitle').textContent = busy ? 'Approve the prompt. Checking the server and tunnel…' : active ? state.peerVerified ? 'Peer handshake verified when this session connected.' : 'Existing tunnel: peer and reachability not verified.' : profile ? state.engine.available ? `Connect to ${profile.name}.` : 'Install WireGuard to enable your connection.' : 'Import a server profile to get started.';
    $('#connection-footer').textContent = active ? 'Routing and DNS follow your profile' : 'Your keys stay on this device';
    const connect = $('#connect-button');
    connect.disabled = busy || (!!profile && !active && !state.engine.available);
    connect.querySelector('span').textContent = busy ? 'Working…' : active ? 'Disconnect tunnel' : profile ? preferFastest ? 'Connect to fastest endpoint' : 'Connect tunnel' : 'Import your first profile';
    connect.querySelector('use').setAttribute('href', !profile ? '#i-upload' : '#i-power');
    $('#route-name').textContent = profile ? profile.name : 'Your server, your choice';
    $('#route-description').textContent = profile ? profile.endpoint : 'Bring a WireGuard .conf profile';
    $('#metric-latency').textContent = Number.isFinite(profile?.latency?.ms) ? profile.latency.ms : '—';
    $('#latency-note').textContent = profile?.latency ? profile.latency.ms === null ? 'No ICMP reply' : 'Endpoint RTT' : 'Not measured';
    $('#session-note').textContent = active ? 'Tunnel active' : 'Inactive';
    $('#engine-label').textContent = state.engine.available ? `${state.engine.platform} engine available` : `${state.engine.platform} engine needs setup`;
    $('#engine-dot').classList.toggle('on', state.engine.available);
    $('#engine-instructions').textContent = state.engine.available ? 'WireGuard is installed. Connecting and disconnecting may request system administrator approval.' : state.engine.instructions;
    $$('.import-button').forEach(button => { button.disabled = busy; });
    $$('.measure-button').forEach(button => { button.disabled = busy || measuring || !state.profiles.length; button.lastChild.textContent = measuring ? 'Measuring…' : 'Check latency'; });
    renderServers($('#overview-servers')); renderServers($('#profile-servers')); updateTimer();
  }

  function updateTimer() {
    const total = state.startedAt ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)) : 0;
    $('#metric-time').textContent = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(n => String(n).padStart(2, '0')).join(':');
  }

  async function importProfile() {
    if (operation) return;
    operation = true; render();
    try { const previous = new Set(state.profiles.map(p => p.id)); apply(await call('importProfile')); const added = state.profiles.find(p => !previous.has(p.id)); if (added) { if (!state.activeId) selectedId = added.id; render(); notify('Profile imported. Your private key stays on this device.'); } }
    catch (error) { notify(error.message, true); }
    finally { operation = false; render(); }
  }

  async function toggleConnection() {
    if (operation) return;
    if (!selectedId) return importProfile();
    operation = true; render();
    try {
      if (state.activeId) { apply(await call('disconnect')); notify('Tunnel disconnected.'); }
      else {
        if (preferFastest) {
          apply(await call('measure'));
          const fastest = [...state.profiles].filter(p => Number.isFinite(p.latency?.ms)).sort((a,b) => a.latency.ms - b.latency.ms)[0];
          if (fastest) selectedId = fastest.id;
        }
        apply(await call('connect', selectedId));
        notify(state.peerVerified ? 'Server handshake verified. Connection checks passed.' : 'System tunnel active. Verify the peer handshake in WireGuard.');
      }
    } catch (error) { notify(error.message, true); try { apply(await call('state')); } catch {} }
    finally { operation = false; render(); }
  }

  async function measure() {
    if (measuring || operation) return;
    measuring = true; render();
    try { apply(await call('measure')); notify(state.profiles.some(p => Number.isFinite(p.latency?.ms)) ? 'Endpoint latency checked. Compare round-trip times below.' : 'No ICMP replies. Your servers may block ping; the VPN can still work.'); }
    catch (error) { notify(error.message, true); }
    finally { measuring = false; render(); }
  }

  function navigate(page) {
    if (!['overview', 'profiles', 'settings', 'help'].includes(page)) return;
    $$('.page').forEach(el => { el.hidden = el.id !== `page-${page}`; });
    $$('.nav-item').forEach(el => { el.classList.toggle('active', el.dataset.page === page); });
    $('#breadcrumb-page').textContent = { overview: 'Overview', profiles: 'Server profiles', settings: 'Preferences', help: 'Setup guide' }[page];
  }
  $$('[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
  $('.brand').addEventListener('click', event => { event.preventDefault(); navigate('overview'); });
  $$('.import-button').forEach(button => button.addEventListener('click', importProfile));
  $$('.measure-button').forEach(button => button.addEventListener('click', measure));
  $$('.docs-button').forEach(button => button.addEventListener('click', async () => { try { await call('openDocs'); } catch (error) { notify(error.message, true); } }));
  $('#connect-button').addEventListener('click', toggleConnection);
  $('#power-button').addEventListener('click', toggleConnection);
  $('#fastest-toggle').checked = preferFastest;
  $('#fastest-toggle').addEventListener('change', event => { preferFastest = event.target.checked; localStorage.setItem('aero:fastest', preferFastest); render(); });
  $('#dismiss-toast').addEventListener('click', () => { $('#toast').hidden = true; });
  $('#cancel-remove').addEventListener('click', () => $('#remove-dialog').close());
  $('#confirm-remove').addEventListener('click', async () => {
    $('#remove-dialog').close();
    if (operation || !pendingRemove) return;
    operation = true; render();
    try { apply(await call('remove', pendingRemove)); notify('Local profile removed.'); }
    catch (error) { notify(error.message, true); }
    finally { pendingRemove = null; operation = false; render(); }
  });
  render();
  if (api) call('state').then(apply).catch(error => notify(error.message, true));
  setInterval(updateTimer, 1000);
  setInterval(async () => { if (!api || operation || measuring || document.hidden) return; try { apply(await call('state')); } catch (error) { notify(error.message, true); } }, 10000);
})();
