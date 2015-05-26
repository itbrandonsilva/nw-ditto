"use strict";

var dgram = require('dgram');
var crypto = require('crypto');
var uuid = require('node-uuid');
var PORT = 8987;


var DittoSocket = function (options) {
    options = options || {};

    this._isServer = !!options.server;

    // The server does need an id. Client will have an _id assigned on a successful connection.
    this._id = null;

    // You may not 'send' or 'broadcast' any messages until the socket is 'ready'.
    this._isReady = false;

    // Data associated with either clients, or the server if you are a client.
    this._connections = {};
    
    var config = options.config || {};
    this._config = {
        maxRetries: config.maxRetries || 3,
        surveyInterval: config.surveyInterval || 10
    }

    this._onMessage = function () {};
    this._onConnect = function () {};
};

DittoSocket.prototype.onMessage = function (f) { this._onMessage = f || function () {}; }
DittoSocket.prototype.onConnect = function (f) { this._onConnect = f || function () {}; }

DittoSocket.prototype.start = function (address, port) {
    if ( (!address) || (!port) ) throw new Error('Missing critical arguments');
    var self = this;

    this._socket = dgram.createSocket('udp4');
    this._socket.on('message', function (data, rinfo) {
        self._handleMessage(data, rinfo);
    });

    this._now = new Date().getTime();
    setInterval(function () {
        self._survey();
    }, this._config.surveyInterval);

    if ( this._isServer ) {
        this._isReady = true;
        this._id = 'server';
        return this._socket.bind(port, address);
    }
    this._connect(address, port);
};

    //socket.on('message', function (data, rinfo) {

    //});


// Options passed to 'options' that are only used internally should instead be
// collapsed into an 'internals' or 'headers' option of sorts.

DittoSocket.prototype.send = function (data, options) {
    var allow = this._isReady;
    if ( options._connect ) allow = true;
    if ( options._ack ) allow = true;
    if ( options._cmsg ) allow = true;
    if ( ! allow ) throw new Error('Socket cannot send before it is ready');
    var self = this;

    (this._isServer ? options.ids = options.ids || Object.keys(this._connections) : options.ids = ['server']);
    if (typeof options.ids == 'string') options.ids = [options.ids];

    // Forcing all messages to be reliable, for now...
    //if (!options._overrideAllBullshit) options.reliable = false;

    var now = new Date().getTime();
    var cMsg = options._cmsg;

    if ( ! cMsg ) {
        var msg = {data: data, ts: now, id: this._id};
        if (options._connect) msg.connect = true;
        if (options._ack) msg.ack = options._ack;
        else if (options.reliable) msg.ackId = genId();

        cMsg = this._cMsg(msg);
    }

    var unackd = {cmsg: cMsg, ts: now};

    options.ids.forEach(function (id) {
        var connection = self._connections[id];
        if ( ! connection ) throw new Error('Invalid connection id: ' + id);

        if (msg) { if ( (! msg.ackId) && (options.reliable) ) throw 'WTF'; }
        if (options.reliable) connection.unackd[msg.ackId] = {data: unackd, retries: 0};

        var rinfo = connection.rinfo;
        self._socket.send(cMsg, 0, cMsg.length, rinfo.port, rinfo.address, function (err) {
            if (err) return console.log(err);
        });
    });

    return msg;
};

DittoSocket.prototype._handleMessage = function (data, rinfo, cb) {
    var msg = this._dcMsg(data);

    if ( ! this._isServer ) {
        if (rinfo.address != this._connections['server'].rinfo.address) return;
    }

    var connectionId = msg.id;
    if (msg.connect) {
        if (this._isServer) connectionId = this._handleConnect(msg, rinfo);
        else {
            this._isReady = true;
            this._id = msg.data.id;
            this._onConnect();
        }
    }

    if ( ! this._isReady ) return;
    if ( ! connectionId ) return;
    var connection = this._connections[connectionId];
    if ( ! connection ) return;

    if (msg.ack) {
        delete connection.unackd[msg.ack];
        return;
    }

    if (msg.ackId) {
        this.send({}, {ids: msg.id, _ack: msg.ackId});
    }

    if (msg.connect) return;

    this._onMessage(msg.data, connectionId);
};

DittoSocket.prototype._connect = function (address, port) {
    this._registerConnection('server', address, port);
    this.send({}, {_connect: true, reliable: true});
};

DittoSocket.prototype._handleConnect = function (msg, rinfo) {
    var clientId = genId();
    this._registerConnection(clientId, rinfo.address, rinfo.port);
    this.send({id: clientId}, {ids: clientId, reliable: true, _connect: true});
    return clientId;
};

DittoSocket.prototype._registerConnection = function (id, address, port) {
    this._connections[id] = {rinfo: {address: address, port: port}, unackd: {}, latency};
};

DittoSocket.prototype._survey = function () {
    var now = new Date().getTime();
    for (var connectionId in this._connections) {
        var connection = this._connections[connectionId];
        for (var ackId in connection.unackd) {
            var ack = connection.unackd[ackId];
            if (ack.retries > this._config.maxRetries) {
                // Should drop this guy? Let application decide? Some kind of config?
                //console.log("Retrying a message a lot: " + ack.retries + " times already against " + connection.rinfo.address);
                throw 'Failed to ack all requests...';
            }
            this.send({}, {_cmsg: ack.data.cmsg, ids: connectionId});
            ack.retries++;
        }
    };
};

DittoSocket.prototype._elapsedMs = function () {
    var now = new Date().getTime();
    var elapsedMs = now - this._now;
    this._now = now;
    return elapsedMs;
};


DittoSocket.prototype._cMsg = function (msg) {
    return new Buffer(JSON.stringify(msg));
};

DittoSocket.prototype._dcMsg = function (msg) {
    return JSON.parse(msg.toString('utf8'));
}

function genId() {
    return uuid.v1();
}

module.exports = {
    DittoSocket: DittoSocket
}

/*
var DittoClient = function (options) {
    this._socket = new DittoSocket(options.port, options.host);
}

var DittoServer = function (options) {
    this._socket = new DittoSocket(options.port);
    this._clients = {}; // Each client will be given a uuid; [averageLatency]
    this._frame = 1;
    this._cache = {}; // Unack'd messages by frame tagged with relevant users;
}

DittoClient.prototype.send = function () {
    return true;
}

DittoClient.protoype.ditto = ditto;
DittoServer.protoype.ditto = ditto;

function ditto = function (obj, options) {
    var id = genId();
    obj.__ditto = {
        id: id,
        values: {},
        new: true, 
        once: options.once, // Ditto this object in the next update and remove it
        meta: options.meta, // Meta data that will allow foreign processes to identify what this object is
        onUpdate: options.onUpdate, // Can take a function; Can take a string 'merge' which will automatically merge all of the updated keys into the context object
        ctx: options.ctx || obj, // Call onUpdate using this context
        scope: options.scope,
        reliable: options.reliable // Will resend unacknowledged data
    };
    
    var keys = options.keys || Object.keys(obj);
    keys.forEach(function (key) {
        Object.defineProperty(obj, key, {
            set: function (value) {
                var d = this.__ditto;
                this.__ditto.values[key] = value;
                this.__ditto.modified = true;
            },
            get: function () {
                return this.__ditto.values[key];
            }
        });
    });

    this._objects[id] = obj;
};

DittoServer.prototype.broadcast = function () {
    //var msg = {objects: [], frame: this._frame};
    var objects = this._objects;
    var toAll = [];
    var toId = [];

    var scopedObjects = {}; // Objects we come across that are scoped will be cached here;
    Object.keys(objects).forEach(function (id) {
        var object = objects[id];
        // We will do more checking here to determine if the object is worth broadcasting
        // We will also only process objects that are in scope of all clients
        // Somewhere here should find and resend Unack'd messages
    });
    this._objects.forEach(function (obj) {
        if (obj.__new) return msg.objects.push(obj);
        if ( ! obj.__touched.length ) return;
        var diff = {'__id': obj.__id};
        obj.__touched.forEach(function (field) {
            diff[field] = obj[field];
        });
        msg.objects.push(diff);
    });
    console.log(msg);
    this._send(msg);
    this._objects.forEach(function (obj) {
        delete obj.__new;
        delete obj.__touched;
    });
    this._frame++;
};

var Ditto = function (options) {
    this._port = options.port || PORT;
    this._socket = dgram.createSocket('udp4');
    this._socket.bind(this._port);
    this._objects = [];
    this._handlers();
}

Ditto.prototype.host = function (options) {
    console.log('host()');
    this._reset();
    this._host = true;
    this._clients = {};
    this._portPool = options.pool || [this._port+1, this._port+10];
}

Ditto.prototype.connect = function (options) {
    console.log('connect()');
    this._reset();
    this._host = false;
    this._host = options.host;
    this._id = this._genId();
    this._send({action: 'connect', id: this._id});
}

Ditto.prototype._handleConnect = function (msg, rinfo) {
    var clients = this._clients;
    var addr = rinfo.address;
    var id = msg.id;
    clients[addr] = clients[addr] || {};
    clients[addr][id] = clients[addr][id] || {};
    
    //this._socket.send(
}

Ditto.prototype._resolveClient = function (msg, rinfo) {

}


Ditto.prototype._reset = function () {
    if ( ! this._socket ) return;
    this._socket.removeAllListeners();
    delete this._frame;
    this._handlers();
}

Ditto.prototype._handlers = function () {
    var self = this;
    this._socket.on('message', function (msg, rinfo) {
        msg = self.dcMsg(msg);
        console.log(rinfo);
        console.log(msg);
        switch (msg.action) {
            case 'connect':
                if (!this.host) break;
                self._handleConnect(msg, rinfo);
                break;
            case 'update':
                self._handleUpdate(msg, rinfo);
                break;
            default:
                break;
        }
    });
}

Ditto.prototype.register = function (obj) {
    for (var key in obj) {
        obj.defineProperty(obj, key, {
            set: function (val) {
                if ( ! this.__values ) this.__values = {};
                this.__values[key] = val;
                if ( ! this.__touched ) this.__touched = [];
                this.__touched.push(key);
            },
            get: function () {

            }
        }
        console.log(key);
    }
    obj.__id = this._genId();
    obj.__new = true;
    this._objects.push(obj);
};

Ditto.prototype.void = function (obj) {
    var index = this._objects.indexOf(obj);
    if (index) this._objects.splice(index, 1);
};

Ditto.prototype.tick = function () {
    if (this.host) return this.broadcast();
    this.update();
};

Ditto.prototype.broadcast = function () {
    if (!this._frame > -1) this._frame = 0;
    var msg = {objects: [], frame: this._frame};
    this._frame++;
    this._objects.forEach(function (obj) {
        if (obj.__new) return msg.objects.push(obj);
        if ( ! obj.__touched.length ) return;
        var diff = {'__id': obj.__id};
        obj.__touched.forEach(function (field) {
            diff[field] = obj[field];
        });
        msg.objects.push(diff);
    });
    console.log(msg);
    this._send(msg);
    this._objects.forEach(function (obj) {
        delete obj.__new;
        delete obj.__touched;
    });
};

Ditto.prototype.update = function () {

};


Ditto.prototype._genId = function () {
    return uuid.v1();
}

var d = new Ditto({});
if (process.argv[2]) {
    d.host();
} else {
    d.connect({host: "100.33.89.229"});
}

//if (process.argv[2] == "server") {
//    console.log("Server...");
//    socket.bind(41234);
//} else {
//    console.log("Client...");
//    socket.bind(41235);
//    var message = new Buffer('Some bytes');
//    for (var x = 0; x < 3; ++x) {
//    }
//}

*/
