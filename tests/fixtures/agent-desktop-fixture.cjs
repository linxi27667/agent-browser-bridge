const [scenario, ...received] = process.argv.slice(2);
const args = [...received];
if (args[0] === '--headed') args.shift();
const command = args[0];
const input = [];
process.stdin.on('data', chunk => input.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(input).toString('utf8');
  const respond = () => {
    if (scenario === 'version-no-input' && command === 'version' && stdin) {
      console.log(JSON.stringify({ ok: false, error: { code: 'VERSION_STDIN_LEAK', message: 'Version queries must not receive action text' } }));
      process.exitCode = 1;
      return;
    }
    if (scenario === 'malformed') { process.stdout.write('invalid output containing ' + stdin); return; }
    if (scenario === 'overflow') { process.stdout.write('x'.repeat(65536)); return; }
    if (scenario === 'unsafe-error') {
      console.log(JSON.stringify({ version: '2.6', ok: false, error: {
        code: 'ACTION_FAILED', message: 'Could not save ' + stdin.slice(0, 5),
        disposition: { delivery: 'delivered_unverified', retry: 'unsafe' },
        recovery: { strategy: 'observe_only' }, details: { value: stdin },
      } }));
      process.exitCode = 1;
      return;
    }
    let data = { command, args: received, stdin, disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } };
    if (command === 'version') data = { version: '1.3.1', os: 'fixture' };
    if (command === 'status') data = { accessibility: 'granted', desktopHome: process.env.AGENT_DESKTOP_HOME };
    if (command === 'list-windows') data = [{ id: 'w-123', app_name: 'fixture.exe', is_focused: scenario !== 'unfocused', bounds: { x: 10, y: 20, width: 200, height: 100 } }];
    console.log(JSON.stringify({ version: '2.6', ok: true, data }));
  };
  if (scenario === 'slow') setTimeout(respond, 5000);
  else if (scenario === 'delay') setTimeout(respond, 130);
  else respond();
});
