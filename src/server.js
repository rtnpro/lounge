"use strict";

var _ = require("lodash");
var pkg = require("../package.json");
var bcrypt = require("bcrypt-nodejs");
var Client = require("./client");
var ClientManager = require("./clientManager");
var express = require("express");
var fs = require("fs");
var io = require("socket.io");
var dns = require("dns");
var redis = require('redis');
var Helper = require("./helper");

var manager = null;

module.exports = function() {
	manager = new ClientManager();

	var app = express()
		.use(allRequests)
		.use(index)
		.use(express.static("client"));

	var config = Helper.config;
	var server = null;

	if (!config.https.enable) {
		server = require("http");
		server = server.createServer(app).listen(config.port, config.host);
	} else {
		server = require("spdy");
		server = server.createServer({
			key: fs.readFileSync(Helper.expandHome(config.https.key)),
			cert: fs.readFileSync(Helper.expandHome(config.https.certificate))
		}, app).listen(config.port, config.host);
	}

	if (config.identd.enable) {
		if (manager.identHandler) {
			log.warn("Using both identd and oidentd at the same time!");
		}

		require("./identd").start(config.identd.port);
	}

	var sockets = io(server, {
		transports: config.transports
	});

	sockets.on("connect", function(socket) {
		if (config.public) {
			auth.call(socket);
		} else {
			init(socket);
		}
	});

	manager.sockets = sockets;

	var protocol = config.https.enable ? "https" : "http";
	log.info("The Lounge v" + pkg.version + " is now running on", protocol + "://" + (config.host || "*") + ":" + config.port + "/", (config.public ? "in public mode" : "in private mode"));
	log.info("Press ctrl-c to stop\n");

	if (!config.public) {
		manager.loadUsers();
		if (config.autoload) {
			manager.autoload();
		}
	}
};

function getClientIp(req) {
	if (!Helper.config.reverseProxy) {
		return req.connection.remoteAddress;
	} else {
		return req.headers["x-forwarded-for"] || req.connection.remoteAddress;
	}
}

function allRequests(req, res, next) {
	res.setHeader("X-Content-Type-Options", "nosniff");
	return next();
}

// Information to populate the About section in UI, either from npm or from git
var gitCommit = null;
try {
	gitCommit = require("child_process")
		.execSync("git rev-parse --short HEAD 2> /dev/null") // Returns hash of current commit
		.toString()
		.trim();
} catch (e) {
	// Not a git repository or git is not installed: treat it as npm release
}

function index(req, res, next) {
	if (req.url.split("?")[0] !== "/") {
		return next();
	}

	return fs.readFile("client/index.html", "utf-8", function(err, file) {
		var data = _.merge(
			pkg,
			Helper.config
		);
		data.gitCommit = gitCommit;
		var template = _.template(file);
		res.setHeader("Content-Security-Policy", "default-src *; style-src * 'unsafe-inline'; script-src 'self'; child-src 'none'; object-src 'none'; form-action 'none'; referrer no-referrer;");
		res.setHeader("Content-Type", "text/html");
		res.writeHead(200);
		res.end(template(data));
	});
}

function init(socket, client) {
	if (!client) {
    auth({}, socket);
		socket.emit("auth", {success: true});
		socket.on("auth", auth);
	} else {
		socket.on(
			"input",
			function(data) {
        console.log('INPUT', data);
				client.input(data);
			}
		);
		socket.on(
			"more",
			function(data) {
        console.log('MORE', data);
				client.more(data);
			}
		);
		socket.on(
			"conn",
			function(data) {
        console.log('CONN', data);
				// prevent people from overriding webirc settings
				data.ip = null;
				data.hostname = null;
				client.connect(data);
			}
		);
		if (!Helper.config.public) {
			socket.on(
				"change-password",
				function(data) {
					var old = data.old_password;
					var p1 = data.new_password;
					var p2 = data.verify_password;
					if (typeof p1 === "undefined" || p1 === "") {
						socket.emit("change-password", {
							error: "Please enter a new password"
						});
						return;
					}
					if (p1 !== p2) {
						socket.emit("change-password", {
							error: "Both new password fields must match"
						});
						return;
					}
					if (!bcrypt.compareSync(old || "", client.config.password)) {
						socket.emit("change-password", {
							error: "The current password field does not match your account password"
						});
						return;
					}

					var salt = bcrypt.genSaltSync(8);
					var hash = bcrypt.hashSync(p1, salt);

					client.setPassword(hash, function(success) {
						var obj = {};

						if (success) {
							obj.success = "Successfully updated your password, all your other sessions were logged out";
							obj.token = client.config.token;
						} else {
							obj.error = "Failed to update your password";
						}

						socket.emit("change-password", obj);
					});
				}
			);
		}
		socket.on(
			"open",
			function(data) {
        console.log('OPEN', data);
				client.open(data);
			}
		);
		socket.on(
			"sort",
			function(data) {
        console.log('SORT', data);
				client.sort(data);
			}
		);
		socket.on(
			"names",
			function(data) {
        console.log('NAMES', data);
				client.names(data);
			}
		);
		socket.join(client.id);
		socket.emit("init", {
			active: client.activeChannel,
			networks: client.networks,
			token: client.config.token || null
		});
	}
}

function reverseDnsLookup(socket, client) {
	client.ip = getClientIp(socket.request);

	dns.reverse(client.ip, function(err, host) {
		if (!err && host.length) {
			client.hostname = host[0];
		} else {
			client.hostname = client.ip;
		}

		init(socket, client);
	});
}

function auth(data, socket) {
	var socket = this || socket;
	if (Helper.config.public) {
		var client = new Client(manager);
		manager.clients.push(client);
		socket.on("disconnect", function() {
			manager.clients = _.without(manager.clients, client);
			client.quit();
		});
		if (Helper.config.webirc) {
			reverseDnsLookup(socket, client);
		} else {
			init(socket, client);
		}
	} else {
		var success = false;
    var sessionId = null;
    _.each(socket.client.request.headers.cookie.split(';'), function(item) {
      item = item.trim();
      var tokens = item.split('=');
      if (tokens[0] === 'session')
        sessionId = tokens[1];
    });

    function _auth (session) {
      _.each(manager.clients, function(client) {
        if (session && session.username === client.config.user) {
          success = true;
        }
        if (data.token) {
          if (data.token === client.config.token) {
            success = true;
          }
        } else if (client.config.user === data.user) {
          if (bcrypt.compareSync(data.password || "", client.config.password)) {
            success = true;
          }
        }
        if (success) {
          if (Helper.config.webirc !== null && !client.config["ip"]) {
            reverseDnsLookup(socket, client);
          } else {
            init(socket, client);
          }
          return false;
        }
      });
      if (!success) {
        socket.emit("auth", {success: success});
      }
    }
    if (sessionId) {
      var client = redis.createClient();
      client.get('session:' + sessionId, function(err, res) {
        if (err || !res)
          _auth();
        else {
          var session = JSON.parse(res);
          _auth(session);
        }
        client.quit();
      });
    } else {
      _auth();
    }
	}
}
