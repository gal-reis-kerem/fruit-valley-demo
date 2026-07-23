// Central event bus. The engine emits structured events; consumers (the
// Electron dashboard, the CLI logger) subscribe. Event shapes:
//   'worker'   { worker: 'naama'|'yuval', text, newJob?: boolean }
//   'status'   { state }                    connection state changes
//   'qr'       { qr }                       raw QR string for pairing
//   'crm'      { companies: [names] }       CRM refreshed from the sheet
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

// convenience emitters used across the engine
bus.naama = (text, newJob = false) => bus.emit('worker', { worker: 'naama', text, newJob, at: Date.now() });
bus.yuval = (text, newJob = false) => bus.emit('worker', { worker: 'yuval', text, newJob, at: Date.now() });

module.exports = bus;
