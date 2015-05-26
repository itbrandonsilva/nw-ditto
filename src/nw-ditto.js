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
