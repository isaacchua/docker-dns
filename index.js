import rc from 'rc';
import debug from 'debug';
import { createSocket } from 'dgram';
import { parse as dnsParse } from 'native-dns-packet';
import { createAnswer, records, listAnswer } from './util.js';

var PORT = process.env.PORT || 53
var EXTERNAL_DNS = process.env.EXTERNAL_DNS || '8.8.8.8,8.8.4.4'

const opts = rc('dnsproxy', {
  host: '0.0.0.0',
  logging: 'dnsproxy:query',
  domains: {
    '.docker': '127.0.0.1',
    '.rancher': '192.168.99.100'
  },
  fallback_timeout: 350
})

if (!opts.port) opts.port = PORT
if (!opts.host) opts.host = '0.0.0.0'
if (!opts.nameservers) opts.nameservers = EXTERNAL_DNS.split(',')
if (!opts.servers) opts.servers = {}
if (!opts.domains) opts.domains = {}
if (!opts.hosts) opts.hosts = {}

process.env.DEBUG_FD = process.env.DEBUG_FD || 1
process.env.DEBUG = process.env.DEBUG || opts.logging
var d = process.env.DEBUG.split(',')
d.push('dnsproxy:error')
process.env.DEBUG = d.join(',')

const logdebug = debug('dnsproxy:debug');
const logquery = debug('dnsproxy:query');
const logerror = debug('dnsproxy:error');

logdebug('options: %j', opts)

const server = createSocket('udp4');

server.on('listening', () => {
  var address = server.address();
  console.log(`dns server listening ${address.address}:${address.port}`);
});

server.on('error', function (err) {
  logerror('Server Error: %s', err)
})

server.on('message', function (message, rinfo) {
  var nameserver = opts.nameservers[0]
  var returner = false

  const query = dnsParse(message);
  var domain = query.question[0].name
  var type = query.question[0].type

  logdebug('query: %j', query)

  Object.keys(opts.hosts).forEach(function (h) {
    if (domain === h) {
      var answer = opts.hosts[h]
      if (typeof opts.hosts[opts.hosts[h]] !== 'undefined') {
        answer = opts.hosts[opts.hosts[h]]
      }

      logquery('type: host, domain: %s, answer: %s', domain, opts.hosts[h])

      const res = createAnswer(query, answer);
      server.send(res, 0, res.length, rinfo.port, rinfo.address)

      returner = true
    }
  })

  if (returner) {
    return
  }

  Object.keys(opts.domains).forEach(function (s) {
    var sLen = s.length
    var dLen = domain.length

    if (domain.indexOf(s) >= 0 && domain.indexOf(s) === (dLen - sLen)) {
      var answer = opts.domains[s]
      if (typeof opts.domains[opts.domains[s]] !== 'undefined') {
        answer = opts.domains[opts.domains[s]]
      }

      logquery('type: server, domain: %s, answer: %s', domain, opts.domains[s])

      const res = createAnswer(query, answer);
      server.send(res, 0, res.length, rinfo.port, rinfo.address)

      returner = true
    }
  })

  if (returner) {
    return
  }

  Object.keys(opts.servers).forEach(function (s) {
    if (domain.indexOf(s) !== -1) {
      nameserver = opts.servers[s]
    }
  })

  var fallback
  (function queryns (message, nameserver) {
    const sock = createSocket('udp4');
    sock.send(message, 0, message.length, 53, nameserver, function () {
      fallback = setTimeout(function () {
        queryns(message, opts.nameservers[0])
      }, opts.fallback_timeout)
    })
    sock.on('error', function (err) {
      logerror('Socket Error: %s', err)
      process.exit(5)
    })
    sock.on('message', function (response) {
      clearTimeout(fallback)
      logquery('type: primary, nameserver: %s, query: %s, type: %s, answer: %s', nameserver, domain, records[type] || 'unknown', listAnswer(response));
      server.send(response, 0, response.length, rinfo.port, rinfo.address)
      sock.close()
    })
  }(message, nameserver))
})

server.bind(opts.port, opts.host)

