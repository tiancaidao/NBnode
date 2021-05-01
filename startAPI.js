var express = require("express");
var bodyParser = require("body-parser");
var cors = require("cors");
var dns = require("dns");
var axios = require("axios");
var app = express();
var appSSL = express();
const { createProxyMiddleware } = require("http-proxy-middleware");

const config = require("./core/config.js");

const defaultConfig = config[config.env];
let domainMap = {};
let localWebGateway = null;
let localAPIGateway = null;
const SSLDir = "./ssl.d/";
async function proxyRequest(req, res, path, nbdomain) {
  try {
    const cookie = req.headers ? ( req.headers.cookie ? req.headers.cookie : "" )  : "";
    //const url = localGateway + nbdomain + path;
    const url = localWebGateway + nbdomain + path;
    console.log("getting url:", url);
    let res1 = await axios.get(url, {
      method: "GET",
      withCredentials: true,
      headers: { Cookie: cookie },
      responseType: "stream",
    });
    res.set(res1.headers);
    res1.data.pipe(res);
  } catch (e) {
    //console.log(e);
    res.status(e.response.status).send(e.response.message);
    //res.end(e.message);
  }
}
async function checkNBdomain(domain) {
  console.log("getting TXT of:", domain);
  return new Promise((resolve) => {
    dns.resolve(domain, "TXT", (err, data) => {
      try {
        if (data[0][0]) {
          const nblink = data[0][0].split("=");
          if (nblink[0] === "nblink") {
            console.log("found nblink:",nblink[1]);
            resolve(nblink[1]);
          }
        }
        } catch (e) {}
      resolve(null);
    });
  });
}
function isLocalCall(host){
  return host.indexOf("localhost") != -1 || host.indexOf("127.0.0.1") != -1 || host.indexOf(defaultConfig.node_info.domain)!=-1
}
app.get("/site/add/", async (req, res,next) => {
  //console.log(req);
  const host = req.get("host");
  if(isLocalCall(host)){
    res.end("ok");
    return;
  }
  next();
});

app.get("/*", async (req, res, next) => {
  const host = req.get("host");
  console.log(host);
  if (host.indexOf("localhost") != -1 || host.indexOf("127.0.0.1") != -1 || host.indexOf(defaultConfig.node_info.domain)!=-1) {
    console.log("got local call, ignore...")
    next();
    return;
  }
  let nbdomain = domainMap[host];
  if(nbdomain==="none"){ //already checked
    next();return;
  }
  if (!nbdomain) {
    nbdomain = await checkNBdomain(host);
    if (nbdomain) domainMap[host] = nbdomain;
    else {
      domainMap[host] = "none";
      next();
      return;
    }
  }
  proxyRequest(req, res, req.path, nbdomain);
}); 

setInterval(()=>{
  //console.log("clear domainMap cache");
  domainMap = []; //clear domainMap cache
},60*1000);

app.listen(defaultConfig.node_port, async function () {
  console.log(`NBnode server started on port ${defaultConfig.node_port}...`);

  var proxyPassConfig = defaultConfig.proxy_map;

  for (uri in proxyPassConfig) {
    uri = uri.trim().toLowerCase();
    console.log("uri",uri);
    let env = defaultConfig;
    let service_folder = proxyPassConfig[uri];
    const service = require("./modules/" + service_folder + "/index.js");
    const port = await service(env);
    const localAddr = "http://localhost:" + port;
    const pa = "^" + uri;
    if(uri==="/web/") localWebGateway = localAddr+"/";
    if(uri==="/api/") localAPIGateway = localAddr+"/";
    app.use(
      uri,
      createProxyMiddleware({
        target: localAddr,
        changeOrigin: true,
        pathRewrite: { [pa]: "" },
      })
    );
    /*appSSL.use(
      uri,
      createProxyMiddleware({
        target: localAddr,
        changeOrigin: true,
        pathRewrite: { [pa]: "" },
      })
    ); */
  }
  console.log(localWebGateway,localAPIGateway)
  app.use(cors());
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());
});

//Start HTTPS server
if(defaultConfig.node_info.domain){
  (async()=>{
    const localAPI = "http://localhost:"+defaultConfig.node_port;
    appSSL.use(createProxyMiddleware("**",{target: localAPI,}));
    let domainError={};
    var greenlock = require('@root/greenlock').create({
      packageRoot: __dirname,
      configDir: SSLDir,
      maintainerEmail: defaultConfig.node_info.email,
      notify: function(event, details) {
        if ('error' === event) {
            // `details` is an error object in this case
            console.error("GL Error, subject:",details);
            console.log("DE:",domainError);
            (!domainError[details.subject])&&(domainError[details.subject]=0);
            if(++domainError[details.subject]>2){
              console.log("GL remove, subject:",details.subject);
              greenlock.sites.remove({subject:details.subject});
            }
        }
    }
    });
    /*console.log(greenlock);
    const res = await greenlock.sites.add({
      subject: defaultConfig.node_info.domain,
      altnames: [defaultConfig.node_info.domain],
    });
    defaultConfig.SSL.forEach(site=>{
      greenlock.sites.add({
        subject: site,
        altnames: [site],
      });
    }) */
    const green = require('greenlock-express')
    .init(()=>{
      return {
        greenlock,cluster:false
      }
    });
      // Serves on 80 and 443
      // Get's SSL certificates magically!
      green.serve(appSSL);
  })();
}
