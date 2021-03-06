"use strict";

plugin.consumes = [
    "connect.static", 
    "connect",
    "preview.handler",
    "connect.render",
    "connect.render.ejs"
];
plugin.provides = ["api", "passport"];

module.exports = plugin;
    
var fs = require("fs");
var http = require("http");
var assert = require("assert");
var async = require("async");
var join = require("path").join;
var extend = require("util")._extend;
var resolve = require("path").resolve;
var basename = require("path").basename;
var frontdoor = require("frontdoor");

function plugin(options, imports, register) {
    var previewHandler = imports["preview.handler"];
    var statics = imports["connect.static"];
    
    assert(options.workspaceDir, "Option 'workspaceDir' is required");
    assert(options.options, "Option 'options' is required");
    

    // serve index.html
    statics.addStatics([{
        path: __dirname + "/www",
        mount: "/"
    }]);
    
    statics.addStatics([{
        path: __dirname + "/../../configs",
        mount: "/configs"
    }]);

    statics.addStatics([{
        path: __dirname + "/../../test/resources",
        mount: "/test"
    }]);

    var api = frontdoor();
    imports.connect.use(api);
    
    api.get("/", function(req, res, next) {
        res.writeHead(302, { "Location": options.sdk ? "/ide.html" : "/static/places.html" });
        res.end();
    });
    
    api.get("/ide.html", {
        params: {
            workspacetype: {
                source: "query",
                optional: true
            },
            devel: {
                source: "query",
                optional: true
            },
            collab: {
                type: "number",
                optional: true,
                source: "query"
            },
            nocollab: {
                type: "number",
                optional: true,
                source: "query"
            },
            debug: {
                optional: true,
                source: "query"
            },
            packed: {
                source: "query",
                type: "number",
                optional: true
            }, 
            token: {
                source: "query",
                optional: true
            },  
            w: {
                source: "query",
                optional: true
            },
	    sessionId: {
                source: "query",
                optional: true
	    }
        }
    }, function(req, res, next) {
        var configType = null;
        if (req.params.workspacetype)
            configType = "workspace-" + req.params.workspacetype;
        else if (req.params.devel)
            configType = "devel";

        var configName = getConfigName(configType, options);

        var collab = options.collab && req.params.collab !== 0 && req.params.nocollab != 1;
        
        api.authenticate()(req, res, function() {
            var opts = extend({}, options);
            opts.options.collab = collab;
            if (req.params.packed == 1)
                opts.packed = opts.options.packed = true;

            var cdn = options.options.cdn;
            options.options.themePrefix = "/static/" + cdn.version + "/skin/" + configName;
            options.options.workerPrefix = "/static/" + cdn.version + "/worker";
            options.options.CORSWorkerPrefix = opts.packed ? "/static/" + cdn.version + "/worker" : "";

            api.updatConfig(opts.options, {
                w: req.params.w,
                token: req.user.token
            });

            var user = opts.options.extendOptions.user;
            user.id = req.user.id;
            user.name = req.user.name;
            user.email = req.user.email;
            user.fullname = req.user.fullname;

            opts.readonly = opts.options.readonly = opts.options.extendOptions.readonly = req.user.readonly;
            
            opts.options.debug = req.params.debug !== undefined;
            res.setHeader("Cache-Control", "no-cache, no-store");
            res.render(__dirname + "/views/standalone.html.ejs", {
                architectConfig: getConfig(configType, opts),
                configName: configName,
                packed: opts.packed,
                version: opts.version
            }, next);            
        });
    });
    
    api.get("/_ping", function(params, callback) {
        return callback(null, {"ping": "pong"}); 
    });
    
    api.get("/preview/:path*", [
        function(req, res, next) {
            req.projectSession = {
                pid: 1
            };
            req.session = {};
            next();
        },
        previewHandler.getProxyUrl(function() {
            return {
                url: "http://localhost:" + options.options.port + "/vfs"
            };
        }),
        previewHandler.proxyCall()
    ]);
    
    api.get("/preview", function(req, res, next) {
        res.redirect(req.url + "/");
    });

    api.get("/vfs-root", function(req, res, next) {
        if (!options.options.testing)
            return next();
            
        res.writeHead(200, {"Content-Type": "application/javascript"});
        res.end("define(function(require, exports, module) { return '" 
            + options.workspaceDir + "'; });");
    });
    api.get("/vfs-home", function(req, res, next) {
        if (!options.options.testing)
            return next();
            
        res.writeHead(200, {"Content-Type": "application/javascript"});
        res.end("define(function(require, exports, module) { return '" 
            + process.env.HOME + "'; });");
    });

    api.get("/update", function(req, res, next) {
        res.writeHead(200, {
            "Content-Type": "application/javascript", 
            "Access-Control-Allow-Origin": "*"
        });
        var path = resolve(__dirname + "/../../build/output/latest.tar.gz");
        fs.readlink(path, function(err, target) {
            res.end((target || "").split(".")[0]);
        });
    });
    
    api.get("/update/:path*", function(req, res, next) {
        var filename = req.params.path;
        var path = resolve(__dirname + "/../../build/output/" + filename);
        
        res.writeHead(200, {"Content-Type": "application/octet-stream"});
        var stream = fs.createReadStream(path);
        stream.pipe(res);
    });

    api.get("/configs/require_config.js", function(req, res, next) {
        var config = res.getOptions().requirejsConfig || {};
        config.waitSeconds = 240;
        
        res.writeHead(200, {"Content-Type": "application/javascript"});
        res.end("requirejs.config(" + JSON.stringify(config) + ");");
    });
    
    api.get("/test/all.json", function(req, res, next) {
        var base = __dirname + "/../../";
        var blacklistfile = base + "/test/blacklist.txt";
        var filefinder = require(base + "/test/filefinder.js");
        filefinder.find(base, "plugins", ".*_test.js", blacklistfile, function(err, result) {
            result.all = result.list.concat(result.blacklist);
            async.filterSeries(result.list, function(file, next) {
                fs.readFile(file, "utf8", function(err, file) {
                    if (err) return next(false);
                    if (file.match(/^"use server"/m) && !file.match(/^"use client"/m))
                        return next(false);
                    next(file.match(/^define\(|^require\(\[/m));
                });
            }, function(files) {
                result.list = files;
                res.writeHead(200, {"Content-Type": "application/json"});
                res.end(JSON.stringify(result, null, 2));
            });
        });
    });
    
    api.get("/api.json", {name: "api"}, frontdoor.middleware.describeApi(api));

    // fake authentication
    api.authenticate = api.authenticate || function() {
        return function(req, res, next) {
            var token = req.params.sessionId || req.params.access_token;
            var config = options.options;
            var url = config.apiUrl + "/user-details?" +
                    "projectId=" + config.extendOptions.project.id;
            if (token) url += "&sessionId=" + token;

            http.get(url, function(res) {
                var body = "";
                res.on("data", function(chunk) {
                    body += chunk.toString();
                });
                res.on("end", function() {
                    try {
                        var details = JSON.parse(body);
                    } catch (e) {
                        return showError(e.message);
                    }
                    req.user = {
                        id: details.id,
                        name: details.name,
                        email: details.email,
                        fullname: details.fullname,
                        readonly: details.readonly,
                        token: details.token
                    };
                    next();
                });
            }).on("error", function(e) {
                showError(e.message);
            });

            function showError(err) {
                console.error(err);
                res.writeHead(500);
                res.end(err);
            }
        };
    };
    api.ensureAdmin = api.ensureAdmin || function() {
        return function(req, res, next) { 
            next(); 
        };
    };
    api.getVfsOptions = api.getVfsOptions || function(user, pid) {
//        if (!options._projects) {
//            options._projects = [options.workspaceDir];
//        }
        var wd = options.workspaceDir;//options.options._projects[pid] || options._projects[0];
        
        return {
            workspaceDir: wd,
            extendOptions: {
                user: user,
                project: {
                    id: pid,
                    name: pid + "-" + wd
                },
                readonly: options.options.extendOptions.readonly
            }
        };
    };    
    api.updatConfig = api.updatConfig || function(opts, params) {
        var id = params.token;
        opts.accessToken = opts.extendToken = id || "token";
        /*
        var user = opts.extendOptions.user;
        user.id = id || -1;
        user.name = id ? "user" + id : "johndoe";
        user.email = id ? "user" + id + "@c9.io" : "johndoe@example.org";
        user.fullname = id ? "User " + id : "John Doe";
         */
        opts.workspaceDir = params.w ? params.w : options.workspaceDir;
        opts.projectName = basename(opts.workspaceDir);
//        if (!options._projects) {
//            options._projects = [options.workspaceDir];
//        }
//        var project = opts.extendOptions.project;
//        var pid = options._projects.indexOf(opts.workspaceDir);
//        if (pid == -1)
//            pid = options._projects.push(opts.workspaceDir) - 1;
//        project.id = pid;
    };
    
    imports.connect.setGlobalOption("apiBaseUrl", "");

    register(null, {
        "api": api,
        "passport": {
            authenticate: function() {
                return function(req, res, next) {
                    console.log("passport.authenticate");
                    req.user = extend({}, options.options.extendOptions.user);
                    next();
                };
            }
        }
    });
}

function getConfigName(requested, options) {
    var name;
    if (requested) {
        name = requested;
    }
    else if (options.workspaceType) {
        name = "workspace-" + options.workspaceType;
    }
    else if (options.options.client_config) {
        // pick up client config from settings, if present
        name = options.options.client_config;
    }
    else if (options.readonly) {
        name = "default-ro";
    }
    else {
        name = "default";
    }

    if (options.local)
        name += "-local";

    return name;
}

function getConfig(requested, options) {
    var filename = __dirname + "/../../configs/client-" + getConfigName(requested, options) + ".js";

    var installPath = options.settingDir || options.installPath || "";
    var workspaceDir = options.options.workspaceDir;
    var settings = {
        "user": join(installPath, "user.settings"),
        "project": join(options.local ? installPath : join(workspaceDir, ".c9"), "project.settings"),
        "state": join(options.local ? installPath : join(workspaceDir, ".c9"), "state.settings")
    };
    
    var fs = require("fs");
    for (var type in settings) {
        var data = "";
        try {
            data = fs.readFileSync(settings[type], "utf8");
        } catch (e) {
        }
        settings[type] = data;
    }
    options.options.settings = settings;
    
    return require(filename)(options.options);
}
