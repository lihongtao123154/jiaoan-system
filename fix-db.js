var {Client}=require('ssh2');
var c=new Client();
c.on('error',function(e){console.error(e.message);process.exit(1)});
c.connect({host:'39.96.31.118',username:'root',password:'Iq1SW2n(p8%a[4L5@',readyTimeout:15000});
var NS='environment-6a0d4a84f3b70f2a79fbd869';
c.on('ready',function(){
  c.exec('kubectl get pod -n '+NS+' -o jsonpath="{.items[0].metadata.name}"',function(e,s){
    var pod='';s.on('data',function(d){pod+=d});s.on('close',function(){
      pod=pod.trim();
      var script = 'var db=require("better-sqlite3")("/data/database.sqlite");db.prepare("UPDATE sport_config SET sportName=? WHERE sportName=?").run("举重","举配");db.prepare("UPDATE sport_config SET sportName=? WHERE sportName=?").run("跆拳道","蹂拳道");db.prepare("UPDATE sport_config SET sportName=? WHERE sportName=?").run("蹦床","蹪床");var r=db.prepare("SELECT sportName FROM sport_config WHERE sportName IN (?,?,?)").all("举重","跆拳道","蹦床");console.log(JSON.stringify(r));';
      var b64 = Buffer.from(script).toString('base64');
      c.exec('kubectl exec -n '+NS+' '+pod+' -- node -e "eval(Buffer.from(\\"'+b64+'\\",\\"base64\\").toString())"',function(e,s){
        var o='';s.on('data',function(d){o+=d});s.stderr.on('data',function(d){o+=d});
        s.on('close',function(){console.log(o.trim());c.end()});
      });
    });
    s.resume();
  });
});
