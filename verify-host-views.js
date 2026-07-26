var pw='Iq1SW2n(p8%a[4L5@';
var {Client}=require('ssh2');
var c=new Client();
c.on('error',function(e){console.error(e.message);process.exit(1)});
c.on('ready',function(){
  var cmd='grep -c "gm-card" /root/jiaoan-data/views/dashboard.ejs; echo ---; head -50 /root/jiaoan-data/views/dashboard.ejs | grep -c "topbar"';
  c.exec(cmd,function(e,s){
    var o='';s.on('data',function(d){o+=d});s.stderr.on('data',function(d){o+=d});
    s.on('close',function(){console.log(o.trim());c.end()});
  });
});
c.connect({host:'39.96.31.118',username:'root',password:pw,readyTimeout:15000});
