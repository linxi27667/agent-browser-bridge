const fs = require('node:fs');

const [scenario, ...received] = process.argv.slice(2);
const args = [...received];
if (args[0] === '--headed') args.shift();
const command = args[0];
const input = [];
process.stdin.on('data', chunk => input.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(input).toString('utf8');
  const respond = () => {
    if (command === 'batch' && args.includes('--help')) {
      if (scenario.startsWith('batch-stdin') || scenario.startsWith('composer-')) {
        process.stdout.write('Usage: agent-desktop batch [OPTIONS] [COMMANDS_JSON]\n  --stdin  Read JSON array of batch commands from standard input\n');
      } else {
        process.stdout.write('Usage: agent-desktop batch [OPTIONS] <COMMANDS_JSON>\n');
      }
      return;
    }
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

    if (command === 'batch') {
      const rawJson = args.includes('--stdin') ? stdin : args[1];
      const items = JSON.parse(rawJson || '[]');
      let currentEditValue = '';
      let shotSeq = 0;
      const results = [];
      let stopped = null;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.command === 'set-value') {
          currentEditValue = String(item.args?.value ?? '');
          results.push({
            index: i,
            command: 'set-value',
            execution: 'completed',
            ok: true,
            data: { action: 'set_value', post_state: { value: currentEditValue }, disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } },
          });
        } else if (item.command === 'get') {
          const val = scenario === 'composer-mismatch' && i > 3 ? 'corrupted-value' : currentEditValue;
          results.push({
            index: i,
            command: 'get',
            execution: 'completed',
            ok: true,
            data: { property: item.args?.property || 'value', value: val },
          });
        } else if (item.command === 'click') {
          if (scenario === 'composer-submit-fail' && i >= 5) {
            results.push({
              index: i,
              command: 'click',
              execution: 'completed',
              ok: false,
              error: { code: 'ACTION_FAILED', message: 'Send button failed', disposition: { delivery: 'unknown', retry: 'unsafe' } },
            });
            stopped = { reason: 'stop_on_error', index: i };
            break;
          }
          currentEditValue = '';
          results.push({
            index: i,
            command: 'click',
            execution: 'completed',
            ok: true,
            data: { action: 'click', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } },
          });
        } else if (item.command === 'select' && scenario.includes('select-unsupported')) {
          results.push({
            index: i,
            command: 'select',
            execution: 'completed',
            ok: false,
            error: {
              code: 'ACTION_NOT_SUPPORTED',
              message: 'ComboBox does not implement SelectionItemPattern',
              disposition: { delivery: 'not_delivered', retry: 'safe' },
            },
          });
          stopped = { reason: 'stop_on_error', index: i };
          break;
        } else if (item.command === 'screenshot') {
          shotSeq += 1;
          const outPath = item.args?.output_path;
          if (outPath) {
            const marker = scenario === 'composer-visual-unchanged' ? 'STATIC_FRAME' : `FRAME_${shotSeq}`;
            fs.writeFileSync(outPath, Buffer.from(`PNG_FIXTURE_${marker}_` + 'x'.repeat(80), 'utf8'));
          }
          results.push({ index: i, command: 'screenshot', execution: 'completed', ok: true, data: { saved: outPath } });
        } else {
          results.push({
            index: i,
            command: item.command,
            execution: 'completed',
            ok: true,
            data: { command: item.command, ...(item.args?.text ? { text: item.args.text } : {}) },
          });
        }
      }
      console.log(JSON.stringify({
        version: '2.6',
        ok: true,
        data: {
          results,
          total_entries: items.length,
          completed_entries: results.length,
          not_started_entries: items.length - results.length,
          elapsed_ms: 12,
          ...(stopped ? { stopped } : {}),
        },
      }));
      return;
    }

    if (scenario === 'cap-minimized' && command === 'list-windows') {
      const restored = process.env.ABB_TEST_RESTORED === '1';
      console.log(JSON.stringify({
        version: '2.6',
        ok: true,
        data: [{
          id: 'w-min',
          app_name: 'chat.exe',
          title: 'Chat',
          minimized: !restored,
          is_focused: restored,
          bounds: restored ? { x: 50, y: 50, width: 800, height: 600 } : { x: -32000, y: -32000, width: 0, height: 0 },
        }],
      }));
      return;
    }
    if (scenario === 'cap-caption-only' && command === 'snapshot') {
      console.log(JSON.stringify({
        version: '2.6',
        ok: true,
        data: {
          snapshot_id: 'scap1',
          ref_count: 5,
          tree: {
            role: 'window',
            name: 'CustomApp',
            children: [
              {
                role: 'group',
                name: '',
                ref_id: '@scap1:e1',
                native_id: { kind: 'automation_id', value: 'TitleBar' },
                children: [
                  { role: 'menu', name: '系统', native_id: { kind: 'automation_id', value: 'SystemMenuBar' }, children: [{ role: 'menuitem', name: '系统', ref_id: '@scap1:e2' }] },
                  { role: 'button', name: '最小化', ref_id: '@scap1:e3', native_id: { kind: 'automation_id', value: 'Minimize-Restore' } },
                  { role: 'button', name: '最大化', ref_id: '@scap1:e4', native_id: { kind: 'automation_id', value: 'Maximize-Restore' } },
                  { role: 'button', name: '关闭', ref_id: '@scap1:e5', native_id: { kind: 'automation_id', value: 'Close' } },
                ],
              },
            ],
          },
        },
      }));
      return;
    }
    if (scenario === 'cap-uia' && command === 'snapshot') {
      console.log(JSON.stringify({
        version: '2.6',
        ok: true,
        data: {
          snapshot_id: 'suia1',
          ref_count: 4,
          tree: {
            role: 'window',
            name: 'StandardApp',
            children: [
              { role: 'button', name: '关闭', ref_id: '@suia1:e1' },
              { role: 'textfield', name: '输入消息', ref_id: '@suia1:e2' },
              { role: 'button', name: '发送', ref_id: '@suia1:e3' },
            ],
          },
        },
      }));
      return;
    }

    if (scenario === 'select-unsupported' && command === 'select') {
      console.log(JSON.stringify({
        version: '2.6',
        ok: false,
        error: {
          code: 'ACTION_NOT_SUPPORTED',
          message: 'ComboBox does not implement SelectionItemPattern',
          disposition: { delivery: 'not_delivered', retry: 'safe' },
        },
      }));
      process.exitCode = 1;
      return;
    }

    let data = { command, args: received, stdin, disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } };
    if (command === 'version') data = { version: scenario.startsWith('batch-stdin') ? '1.3.2-dev' : '1.3.1', os: 'fixture' };
    if (command === 'status') data = { accessibility: 'granted', desktopHome: process.env.AGENT_DESKTOP_HOME };
    if (command === 'screenshot' && !args.some(a => a.endsWith('.png'))) {
      data = {
        data: Buffer.from('PNG_BASE64_FIXTURE').toString('base64'),
        format: 'png',
        width: 200,
        height: 100,
        scale_factor: 1,
      };
    }
    if (command === 'list-windows') {
      data = [{
        id: 'w-123',
        app_name: 'fixture.exe',
        title: 'Fixture Window',
        is_focused: scenario !== 'unfocused',
        bounds: { x: 10, y: 20, width: 200, height: 100 },
      }];
    }
    console.log(JSON.stringify({ version: '2.6', ok: true, data }));
  };
  if (scenario === 'slow') setTimeout(respond, 5000);
  else if (scenario === 'delay') setTimeout(respond, 130);
  else respond();
});
