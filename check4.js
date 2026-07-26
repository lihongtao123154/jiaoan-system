var {Client}=require('ssh2');
var c=new Client();
c.on('error',function(e){console.error(e.message);process.exit(1)});
c.connect({host:'39.96.31.118',username:'root',password:'Iq1SW2n(p8%a[4L5@',readyTimeout:15000});
var NS='environment-6a0d4a84f3b70f2a79fbd869';
c.on('ready',function(){
  c.exec('kubectl get pod -n '+NS+' -o jsonpath="{.items[0].metadata.name}"',function(e,s){
    var pod='';s.on('data',function(d){pod+=d});s.on('close',function(){
      pod=pod.trim();
      var cmds = [
        'grep "info.count" /src/views/dashboard.ejs',
        'grep "fonts.googleapis" /src/server.js',
        'grep "api/sports/list" /src/server.js'
      ];
      var idx = 0;
      function next(){
        if(idx >= cmds.length){c.end();return;}
        c.exec('kubectl exec -n '+NS+' '+pod+' -- '+cmds[idx],function(e,s){
          var o='';s.on('data',function(d){o+=d});s.stderr.on('data',function(d){o+=d});
          s.on('close',function(){console.log('['+idx+']',cmds[idx]);console.log(o.trim());idx++;next()});
        });
      }
      next();
    });
    s.resume();
  });
});
