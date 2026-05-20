const { Client } = require('ssh2');
const conn = new Client();
const host = '39.96.31.118';
const pass = 'Iq1SW2n(p8%a[4L5@';

const commands = [
  'cat /etc/os-release',
  'echo "---NODE---"',
  'which node || echo no-node',
  'which npm || echo no-npm',
  'echo "---MEM---"',
  'free -h',
  'echo "---DISK---"',
  'df -h',
  'echo "---FIREWALL---"',
  'ufw status 2>/dev/null || firewall-cmd --state 2>/dev/null || iptables -L -n 2>/dev/null | head -20 || echo no-firewall',
  'echo "---DONE---"'
];

conn.on('ready', function() {
  console.log('SSH Connected!');
  runNext();
});

function runNext() {
  if (commands.length === 0) return conn.end();
  const cmd = commands.shift();
  conn.exec(cmd, function(err, stream) {
    if (err) { console.error('ERR:', err.message); return runNext(); }
    let out = '';
    stream.on('data', d => out += d.toString());
    stream.stderr.on('data', d => out += d.toString());
    stream.on('close', function() { console.log(out); runNext(); });
  });
}

conn.on('error', function(e) { console.error('SSH Error:', e.message); process.exit(1); });

conn.connect({
  host, username: 'root', password: pass,
  readyTimeout: 30000
});
