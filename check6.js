var {Client}=require('ssh2');
var c=new Client();
var b64='dmFyIGRiPXJlcXVpcmUoImJldHRlci1zcWxpdGUzIikoIi9kYXRhL2RhdGFiYXNlLnNxbGl0ZSIpO3ZhciByPWRiLnByZXBhcmUoIlNFTEVDVCBzYy5zcG9ydEdyb3VwLHNjLnNwb3J0TmFtZSwoU0VMRUNUIENPVU5UKCopIEZST00gcGxhbnMgV0hFUkUgc3BvcnRHcm91cD1zYy5zcG9ydEdyb3VwIEFORCBzcG9ydE5hbWU9c2Muc3BvcnROYW1lKSBhcyBjbnQgRlJPTSBzcG9ydF9jb25maWcgc2MgT1JERVIgQlkgc2Muc29ydE9yZGVyIikuYWxsKCk7Y29uc29sZS5sb2coSlNPTi5zdHJpbmdpZnkocikp';
c.on('error',function(e){console.error(e.message);process.exit(1)});
c.connect({host:'39.96.31.118',username:'root',password:'Iq1SW2n(p8%a[4L5@',readyTimeout:15000});
var NS='environment-6a0d4a84f3b70f2a79fbd869';
c.on('ready',function(){
  c.exec('kubectl get pod -n '+NS+' -o jsonpath="{.items[0].metadata.name}"',function(e,s){
    var pod='';s.on('data',function(d){pod+=d});s.on('close',function(){
      pod=pod.trim();
      c.exec('kubectl exec -n '+NS+' '+pod+' -- node -e "eval(Buffer.from(\''+b64+'\',\'base64\').toString())"',function(e,s){
        var o='';s.on('data',function(d){o+=d});s.stderr.on('data',function(d){o+=d});
        s.on('close',function(){console.log(o.trim());c.end()});
      });
    });
    s.resume();
  });
});
