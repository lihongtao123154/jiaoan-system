var {Client}=require('ssh2');
var c=new Client();
c.on('error',function(e){console.error(e.message);process.exit(1)});
c.connect({host:'39.96.31.118',username:'root',password:'Iq1SW2n(p8%a[4L5@',readyTimeout:15000});
var NS='environment-6a0d4a84f3b70f2a79fbd869';
c.on('ready',function(){
  c.exec('kubectl get pod -n '+NS+' -o jsonpath="{.items[0].metadata.name}"',function(e,s){
    var pod='';s.on('data',function(d){pod+=d});s.on('close',function(){
      pod=pod.trim();
      c.exec('kubectl exec -n '+NS+' '+pod+' -- stat -c "%Y" /src/views/dashboard.ejs',function(e,s){
        var o='';s.on('data',function(d){o+=d});s.on('close',function(){
          var ts=o.trim();
          console.log('File timestamp:',ts,new Date(parseInt(ts)*1000).toISOString());
          c.exec('kubectl exec -n '+NS+' '+pod+' -- stat -c "%Y" /src/server.js',function(e,s2){
            var o2='';s2.on('data',function(d){o2+=d});s2.on('close',function(){
              var ts2=o2.trim();
              console.log('Server.js timestamp:',ts2,new Date(parseInt(ts2)*1000).toISOString());
              c.exec('kubectl exec -n '+NS+' '+pod+' -- ps aux | grep node',function(e,s3){
                var o3='';s3.on('data',function(d){o3+=d});s3.stderr.on('data',function(d){o3+=d});
                s3.on('close',function(){
                  console.log('Process uptime:');
                  console.log(o3.trim());
                  c.end();
                });
              });
            });
          });
        });
      });
    });
    s.resume();
  });
});
