'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { ArrowDownRight, ArrowUpRight, Check, Clock3, LocateFixed, LogIn, LogOut, MapPin, PackageCheck, Shirt, Sparkles, Truck, WashingMachine } from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const serviceLabels: Record<string, string> = { WASH_AND_FOLD: 'Wash & fold', DRY_CLEANING: 'Dry cleaning', IRONING: 'Ironing' };
const statusLabels: Record<string, string> = {
  CREATED: 'Order received', DRIVER_ASSIGNED_FOR_PICKUP: 'Courier heading to you', PICKED_UP: 'Picked up',
  AT_LAUNDROMAT: 'At the laundromat', PROCESSING: 'Being cared for', READY_FOR_DELIVERY: 'Ready to come home',
  DRIVER_ASSIGNED_FOR_DROPOFF: 'On the way back', DELIVERED: 'Delivered', CANCELLED: 'Cancelled',
};
const services = [
  { id: 'WASH_AND_FOLD', title: 'Wash & fold', detail: 'A fresh reset, sorted and folded.', icon: WashingMachine },
  { id: 'DRY_CLEANING', title: 'Dry cleaning', detail: 'Thoughtful care for the pieces you love.', icon: Sparkles },
  { id: 'IRONING', title: 'Ironing', detail: 'Pressed, polished, ready to wear.', icon: Shirt },
] as const;

type Persona = 'customer' | 'vendor' | 'courier';
type Vendor = { id: string; business_name: string; address: string; distance_meters: number; services: { service: string; priceKobo: number }[] };
type Order = { id: string; status: string; payment_status?: string; subtotal_kobo?: number; created_at?: string; pickup_address?: string; delivery_address?: string; deliveryOtp?: string | null; history?: { status: string; at: string }[]; vendor_accepted_at?: string | null; vendor_response_deadline?: string; items?: { service: string; quantity: number }[] };
type Job = Order & { business_name: string; vendor_latitude: number; vendor_longitude: number; pickup_latitude: number; pickup_longitude: number; delivery_latitude: number; delivery_longitude: number; assigned_to_me: boolean };

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? 'Something went wrong. Please try again.');
  return payload as T;
}

function naira(kobo: number) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(kobo / 100);
}

export default function Home() {
  const [persona, setPersona] = useState<Persona>('customer');
  const [token, setToken] = useState('');
  const [user, setUser] = useState<{ full_name: string; role: string } | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [selectedVendor, setSelectedVendor] = useState('');
  const [selectedServices, setSelectedServices] = useState<string[]>(['WASH_AND_FOLD']);
  const [address, setAddress] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [pickupPoint, setPickupPoint] = useState({ latitude: 8.9912, longitude: 7.6031 });
  const [deliveryPoint, setDeliveryPoint] = useState({ latitude: 8.9912, longitude: 7.6031 });
  const [orders, setOrders] = useState<Order[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [locations, setLocations] = useState<Record<string, { latitude: number; longitude: number }>>({});
  const [sharingLocation, setSharingLocation] = useState(false);
  const vendor = vendors.find((item) => item.id === selectedVendor);
  const subtotal = useMemo(() => vendor?.services.filter((item) => selectedServices.includes(item.service)).reduce((sum, item) => sum + item.priceKobo, 0) ?? 0, [vendor, selectedServices]);

  useEffect(() => {
    const savedToken = localStorage.getItem('laundryMapToken');
    const savedUser = localStorage.getItem('laundryMapUser');
    if (!savedToken || !savedUser) return;
    try {
      setToken(savedToken);
      const restoredUser = JSON.parse(savedUser) as { full_name: string; role: string };
      setUser(restoredUser);
      setPersona(restoredUser.role.toLowerCase() as Persona);
    } catch {
      localStorage.removeItem('laundryMapToken');
      localStorage.removeItem('laundryMapUser');
    }
  }, []);

  useEffect(() => {
    fetch(`${API}/api/vendors?latitude=8.9912&longitude=7.6031`).then((response) => response.json()).then((data: Vendor[]) => {
      setVendors(data);
      setSelectedVendor(data[0]?.id ?? '');
    }).catch(() => setNotice('Could not connect to nearby laundry partners.'));
  }, []);

  useEffect(() => {
    if (!token || !user) return;
    const connection = io(API, { auth: { token }, transports: ['websocket', 'polling'] });
    connection.on('connect_error', () => setNotice('Live connection unavailable. Refresh to reconnect.'));
    connection.on('order:status', (event: { id: string; status?: string; paymentStatus?: string }) => {
      setOrders((current) => current.map((order) => {
        if (order.id !== event.id) return order;
        const history = event.status && order.history?.at(-1)?.status !== event.status
          ? [...(order.history ?? []), { status: event.status, at: new Date().toISOString() }]
          : order.history;
        return { ...order, status: event.status ?? order.status, payment_status: event.paymentStatus ?? order.payment_status, history };
      }));
      if (event.status) setJobs((current) => current.map((job) => job.id === event.id ? { ...job, status: event.status! } : job));
      setNotice(event.status ? statusLabels[event.status] ?? 'Order updated' : 'Payment confirmed');
    });
    connection.on('order:created', (order: Order) => {
      setOrders((current) => [order, ...current.filter((item) => item.id !== order.id)]);
      if (user.role === 'VENDOR') {
        try {
          const audio = new AudioContext();
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.frequency.value = 740;
          gain.gain.setValueAtTime(0.08, audio.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.start();
          oscillator.stop(audio.currentTime + 0.35);
          oscillator.onended = () => void audio.close();
        } catch { setNotice('A new paid order is waiting.'); }
      }
    });
    connection.on('dispatch:available', () => {
      if (user.role === 'COURIER') request<Job[]>('/api/courier/jobs', token).then(setJobs).catch((error: Error) => setNotice(error.message));
    });
    connection.on('driver:location', (event: { orderId: string; latitude: number; longitude: number }) => {
      setLocations((current) => ({ ...current, [event.orderId]: { latitude: event.latitude, longitude: event.longitude } }));
    });
    setSocket(connection);
    return () => { connection.disconnect(); setSocket(null); };
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) return;
    if (user.role === 'CUSTOMER') request<Order[]>('/api/orders', token).then((items) => setOrders(items.map((order) => ({
      ...order,
      deliveryOtp: sessionStorage.getItem(`laundryMapOtp:${order.id}`) ?? order.deliveryOtp ?? undefined,
    })))).catch((error: Error) => setNotice(error.message));
    if (user.role === 'VENDOR') request<Order[]>('/api/vendor/orders', token).then(setOrders).catch((error: Error) => setNotice(error.message));
    if (user.role === 'COURIER') request<Job[]>('/api/courier/jobs', token).then(setJobs).catch((error: Error) => setNotice(error.message));
  }, [token, user]);

  useEffect(() => {
    if (!socket) return;
    orders.forEach((order) => socket.emit('order:subscribe', order.id));
  }, [socket, orders]);

  useEffect(() => {
    if (!sharingLocation || !socket || user?.role !== 'COURIER') return;
    const activeJobs = jobs.filter((job) => job.assigned_to_me && job.status !== 'DELIVERED');
    if (!activeJobs.length) return;
    if (!navigator.geolocation) {
      setNotice('Location sharing is not available in this browser.');
      setSharingLocation(false);
      return;
    }
    let lastSentAt = 0;
    const watchId = navigator.geolocation.watchPosition((position) => {
      if (Date.now() - lastSentAt < 3000) return;
      lastSentAt = Date.now();
      activeJobs.forEach((job) => socket.emit('driver:location', {
        orderId: job.id,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }));
    }, (error) => {
      setNotice(`Location sharing stopped: ${error.message}`);
      setSharingLocation(false);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [sharingLocation, socket, user?.role, jobs]);

  function choosePersona(value: Persona) {
    setPersona(value);
    setNotice('');
    if (user && user.role !== value.toUpperCase()) setNotice(`Sign in with a ${value} account to open this workspace.`);
  }

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const fields = new FormData(event.currentTarget);
    const body = authMode === 'register'
      ? { fullName: fields.get('name'), email: fields.get('email'), phone: fields.get('phone'), password: fields.get('password') }
      : { email: fields.get('email'), password: fields.get('password') };
    try {
      const result = await fetch(`${API}/api/auth/${authMode === 'register' ? 'register' : 'login'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error ?? 'Unable to sign in');
      if (data.user.role !== persona.toUpperCase()) throw new Error(`This account belongs to the ${data.user.role.toLowerCase()} workspace.`);
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem('laundryMapToken', data.token);
      localStorage.setItem('laundryMapUser', JSON.stringify(data.user));
      setNotice(`Welcome${data.user.full_name ? `, ${data.user.full_name.split(' ')[0]}` : ''}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  async function placeOrder() {
    if (!token || !vendor || !address.trim() || !deliveryAddress.trim() || !selectedServices.length) return setNotice('Choose a service and add both pickup and delivery addresses first.');
    setBusy(true);
    try {
      const created = await request<Order>('/api/orders', token, {
        method: 'POST', body: JSON.stringify({
          vendorId: vendor.id, pickupAddress: address, pickupLatitude: pickupPoint.latitude, pickupLongitude: pickupPoint.longitude,
          deliveryAddress, deliveryLatitude: deliveryPoint.latitude, deliveryLongitude: deliveryPoint.longitude,
          items: selectedServices.map((service) => ({ service, quantity: 1 })),
        }),
      });
      sessionStorage.setItem(`laundryMapOtp:${created.id}`, created.deliveryOtp ?? '');
      setOrders((current) => [created, ...current]);
      socket?.emit('order:subscribe', created.id);
      const payment = await request<{ authorizationUrl: string }>('/api/payments/initialize', token, { method: 'POST', body: JSON.stringify({ orderId: created.id }) });
      window.location.assign(payment.authorizationUrl);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to place order');
    } finally {
      setBusy(false);
    }
  }

  function locatePickup() {
    if (!navigator.geolocation) return setNotice('Location is not available in this browser.');
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      setPickupPoint({ latitude: coords.latitude, longitude: coords.longitude });
      setNotice('Pickup coordinates updated.');
    }, (error) => setNotice(`Could not read your location: ${error.message}`), { enableHighAccuracy: true, timeout: 10000 });
  }

  function locateDelivery() {
    if (!navigator.geolocation) return setNotice('Location is not available in this browser.');
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      setDeliveryPoint({ latitude: coords.latitude, longitude: coords.longitude });
      setNotice('Delivery coordinates updated.');
    }, (error) => setNotice(`Could not read your location: ${error.message}`), { enableHighAccuracy: true, timeout: 10000 });
  }

  async function acceptJob(jobId: string) {
    try {
      const result = await request<{ id: string; status: string }>('/api/courier/jobs/' + jobId + '/accept', token, { method: 'POST' });
      setJobs((current) => current.map((job) => job.id === result.id ? { ...job, status: result.status, assigned_to_me: true } : job));
      setNotice('Dispatch accepted. Your pickup route is ready.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to accept job'); }
  }

  async function updateOrder(orderId: string, status: string) {
    try {
      const result = await request<Order>(`/api/orders/${orderId}/status`, token, { method: 'PATCH', body: JSON.stringify({ status }) });
      setOrders((current) => current.map((order) => order.id === orderId ? { ...order, status: result.status } : order));
      setJobs((current) => current.map((job) => job.id === orderId ? { ...job, status: result.status } : job));
      setNotice(statusLabels[status] ?? 'Order updated');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to update order'); }
  }

  async function acceptVendorOrder(orderId: string) {
    try {
      await request(`/api/vendor/orders/${orderId}/accept`, token, { method: 'POST' });
      setOrders((current) => current.map((order) => order.id === orderId ? { ...order, vendor_accepted_at: new Date().toISOString() } : order));
      setNotice('Order accepted. A courier can now claim pickup.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to accept order'); }
  }

  async function completeJob(jobId: string, otp: string) {
    try {
      const result = await request<{ id: string }>('/api/courier/jobs/' + jobId + '/complete', token, { method: 'POST', body: JSON.stringify({ otp }) });
      setJobs((current) => current.filter((job) => job.id !== result.id));
      setNotice('Delivery confirmed. Thank you.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to confirm delivery'); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="Laundry Map home"><span className="brand-mark"><WashingMachine size={19} /></span><span>laundry<span className="brand-light">map</span></span></a>
        <div className="location-chip"><MapPin size={15} /><span>Karu · Mararaba</span><span className="live-dot" /></div>
        {user ? <button className="account-button" onClick={() => { localStorage.removeItem('laundryMapToken'); localStorage.removeItem('laundryMapUser'); setToken(''); setUser(null); setOrders([]); setJobs([]); }}><LogOut size={15} /> Sign out</button> : <a className="account-button" href="#account"><LogIn size={15} /> Account</a>}
      </header>

      <section className="hero" id="home">
        <div className="hero-copy"><span className="eyebrow"><span className="eyebrow-line" /> LAUNDRY, TAKEN CARE OF</span><h1>Your week,<br /><em>lighter.</em></h1><p>Pickup, expert care, and delivery from the people around your corner.</p><a className="primary-link" href="#services">Book a pickup <ArrowDownRight size={17} /></a></div>
        <div className="hero-art" aria-label="Laundry basket illustration"><div className="sun-disc" /><div className="cloth cloth-one" /><div className="cloth cloth-two" /><div className="cloth cloth-three" /><div className="basket"><span /><span /><span /><span /></div><div className="art-caption"><span>CARE, CLOSE TO HOME</span><span>09°00′N 07°36′E</span></div></div>
      </section>

      <nav className="persona-nav" aria-label="Choose workspace">
        {(['customer', 'vendor', 'courier'] as Persona[]).map((value) => <button key={value} className={persona === value ? 'persona-tab active' : 'persona-tab'} onClick={() => choosePersona(value)}>{value === 'customer' ? <Shirt size={16} /> : value === 'vendor' ? <WashingMachine size={16} /> : <Truck size={16} />}{value === 'customer' ? 'Customer' : value === 'vendor' ? 'Laundry partner' : 'Courier'}{persona === value && <span className="tab-indicator" />}</button>)}
      </nav>

      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss message">×</button></div>}

      <div className="workspace">
        <section className="main-column">
          {persona === 'customer' && <>
            <div className="section-heading" id="services"><div><span className="eyebrow">A GOOD PLACE TO START</span><h2>Choose your care</h2></div><span className="section-index">01 / SERVICES</span></div>
            <div className="service-list">{services.map(({ id, title, detail, icon: Icon }) => {
              const price = vendor?.services.find((entry) => entry.service === id)?.priceKobo;
              const selected = selectedServices.includes(id);
              return <button key={id} className={`service-row ${selected ? 'selected' : ''}`} onClick={() => setSelectedServices((current) => selected ? current.filter((item) => item !== id) : [...current, id])}><span className="service-icon"><Icon size={20} /></span><span className="service-copy"><strong>{title}</strong><small>{detail}</small></span><span className="service-price">{price ? naira(price) : 'Loading'}</span><span className={`check-mark ${selected ? 'checked' : ''}`}>{selected && <Check size={14} />}</span></button>;
            })}</div>

            <div className="section-heading partner-heading"><div><span className="eyebrow">NEAR YOU</span><h2>Local laundry partners</h2></div><span className="section-index">{vendors.length.toString().padStart(2, '0')} IN RANGE</span></div>
            <div className="partner-list">{vendors.map((item, index) => <button key={item.id} className={`partner-row ${selectedVendor === item.id ? 'chosen' : ''}`} onClick={() => setSelectedVendor(item.id)}><span className={`partner-number tone-${index % 3}`}>0{index + 1}</span><span className="partner-name"><strong>{item.business_name}</strong><small>{item.address}</small></span><span className="partner-distance">{(item.distance_meters / 1000).toFixed(1)} km</span><ArrowUpRight size={16} /></button>)}{vendors.length === 0 && <p className="empty-note">Finding laundry partners around Karu and Mararaba…</p>}</div>

            <div className="section-heading order-heading"><div><span className="eyebrow">IN GOOD HANDS</span><h2>Your orders</h2></div>{socket?.connected && <span className="connection-state"><span className="live-dot" /> LIVE</span>}</div>
            {orders.length ? <div className="order-list">{orders.map((order) => <article className="order-row" key={order.id}><span className="order-symbol"><PackageCheck size={18} /></span><span className="order-info"><strong>{order.items?.map((item) => `${item.quantity} × ${serviceLabels[item.service]}`).join(', ') || 'Laundry order'}</strong><small>#{order.id.slice(0, 8)} · {statusLabels[order.status] ?? order.status}</small>{order.deliveryOtp && order.status !== 'DELIVERED' && <small className="delivery-code">Delivery code: {order.deliveryOtp}</small>}{locations[order.id] && <a className="live-location" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${locations[order.id].latitude},${locations[order.id].longitude}`}><span className="live-dot" /> Courier location · view map</a>}{order.history?.length ? <div className="order-history">{order.history.map((entry, index) => <span className={entry.status === order.status ? 'history-step current' : 'history-step'} key={`${entry.status}-${index}`}><i />{statusLabels[entry.status] ?? entry.status}<small>{new Date(entry.at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })}</small></span>)}</div> : null}</span><span className="status-pill">{order.payment_status === 'PENDING' ? 'Payment pending' : order.status === 'DELIVERED' ? 'Complete' : 'In progress'}</span></article>)}</div> : <p className="empty-note">Your next fresh start will show up here.</p>}
          </>}

          {persona === 'vendor' && <>
            <div className="section-heading"><div><span className="eyebrow">PARTNER WORKSPACE</span><h2>Incoming orders</h2></div><span className="section-index">ACCEPT WITHIN 02:00</span></div>
            <p className="intro-note">New pickup requests appear here in real time. Order acceptance is time-bound so customers can keep moving.</p>
            {user?.role === 'VENDOR' ? orders.map((order) => <VendorOrder key={order.id} order={order} onAccept={acceptVendorOrder} onUpdate={updateOrder} />) : <AccountPrompt persona="vendor" onSelect={setPersona} />}
          </>}

          {persona === 'courier' && <>
            <div className="section-heading"><div><span className="eyebrow">DISPATCH BOARD</span><h2>Routes ready to run</h2></div><span className="section-index">KARU · MARARABA</span></div>
            <p className="intro-note">Each job includes both legs: collect from the customer, then return clean laundry to their door.</p>
            {user?.role === 'COURIER' && <button className={sharingLocation ? 'secondary-button location-sharing' : 'secondary-button'} onClick={() => setSharingLocation((value) => !value)}><LocateFixed size={15} />{sharingLocation ? 'Stop sharing location' : 'Share live location'}</button>}
            {user?.role === 'COURIER' ? jobs.map((job) => {
              const isReturnLeg = ['READY_FOR_DELIVERY', 'DRIVER_ASSIGNED_FOR_DROPOFF'].includes(job.status);
              const origin = isReturnLeg ? `${job.vendor_latitude},${job.vendor_longitude}` : `${job.pickup_latitude},${job.pickup_longitude}`;
              const destination = isReturnLeg ? `${job.delivery_latitude},${job.delivery_longitude}` : `${job.vendor_latitude},${job.vendor_longitude}`;
              return <article className="dispatch-card" key={job.id}><div className="dispatch-top"><span className="eyebrow">{job.assigned_to_me ? statusLabels[job.status] : 'PICKUP + RETURN'}</span><span className="status-pill">PAID</span></div><h3>{job.business_name}</h3><div className="route-line"><div><span className="route-dot pickup" /><span><small>LEG 1 · PICKUP</small><strong>{job.pickup_address}</strong></span></div><span className="route-connector" /><div><span className="route-dot delivery" /><span><small>LEG 2 · DELIVERY</small><strong>{job.delivery_address}</strong></span></div></div><div className="dispatch-actions"><a className="secondary-button" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}`}><MapPin size={15} /> Open current leg</a>{!job.assigned_to_me ? <button className="solid-button" onClick={() => acceptJob(job.id)}>Accept dispatch <ArrowUpRight size={15} /></button> : job.status === 'DRIVER_ASSIGNED_FOR_PICKUP' ? <button className="solid-button" onClick={() => updateOrder(job.id, 'PICKED_UP')}>Confirm pickup <ArrowUpRight size={15} /></button> : job.status === 'PICKED_UP' ? <button className="solid-button" onClick={() => updateOrder(job.id, 'AT_LAUNDROMAT')}>Arrived at partner <ArrowUpRight size={15} /></button> : job.status === 'READY_FOR_DELIVERY' ? <button className="solid-button" onClick={() => updateOrder(job.id, 'DRIVER_ASSIGNED_FOR_DROPOFF')}>Start return leg <ArrowUpRight size={15} /></button> : job.status === 'DRIVER_ASSIGNED_FOR_DROPOFF' ? <DeliveryConfirm onConfirm={(otp) => completeJob(job.id, otp)} /> : null}</div></article>;
            }) : <AccountPrompt persona="courier" onSelect={setPersona} />}
            {user?.role === 'COURIER' && jobs.length === 0 && <p className="empty-note">No paid dispatches are waiting right now.</p>}
          </>}
        </section>

        <aside className="side-column">
          {persona === 'customer' ? <div className="booking-panel" id="account"><div className="panel-topline"><span>YOUR PICKUP</span><LocateFixed size={16} /></div><h3>A little less<br />on your list.</h3><label className="field-label" htmlFor="pickup">Pickup address</label><textarea id="pickup" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Street, estate, or landmark" rows={2} /><div className="address-hint"><MapPin size={13} /><span>Karu / Mararaba, Nasarawa</span><button type="button" className="text-button" onClick={locatePickup}>Use my location</button></div><label className="field-label" htmlFor="delivery">Delivery address</label><textarea id="delivery" value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} placeholder="Street, estate, or landmark" rows={2} /><div className="address-hint"><MapPin size={13} /><span>Karu / Mararaba, Nasarawa</span><button type="button" className="text-button" onClick={locateDelivery}>Use my location</button></div><div className="summary-line"><span>{selectedServices.length} service{selectedServices.length === 1 ? '' : 's'}</span><strong>{subtotal ? naira(subtotal) : 'Choose care'}</strong></div>{user?.role === 'CUSTOMER' ? <button className="solid-button wide" onClick={placeOrder} disabled={busy || !vendor}>{busy ? 'Preparing checkout…' : 'Continue to payment'}<ArrowUpRight size={16} /></button> : <a className="solid-button wide" href="#account">Sign in to book <ArrowUpRight size={16} /></a>}<p className="secure-note">Secure checkout by Paystack · Prices in NGN</p></div> : <div className="service-note"><span className="service-note-icon"><Clock3 size={18} /></span><span className="eyebrow">LOCAL, HUMAN, ON TIME</span><p>{persona === 'vendor' ? 'A calm, clear queue for the work that keeps your neighborhood moving.' : 'Good routes start with a clear handoff. Accept a dispatch and keep both legs in view.'}</p><span className="note-rule" /><small>NASARAWA STATE<br />ABUJA PILOT CORRIDOR</small></div>}

          {!user ? <div className="auth-panel"><div className="auth-heading"><span className="eyebrow">YOUR ACCOUNT</span><h3>{authMode === 'login' ? 'Welcome back.' : 'Let’s get started.'}</h3></div><form onSubmit={submitAuth} className="auth-form">{authMode === 'register' && <label>Full name<input name="name" autoComplete="name" minLength={2} required /></label>}<label>Email address<input name="email" type="email" autoComplete="email" required /></label>{authMode === 'register' && <label>Nigerian mobile<input name="phone" type="tel" placeholder="+2348012345678" pattern="\+234[0-9]{10}" required /></label>}<label>Password<input name="password" type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} minLength={authMode === 'register' ? 12 : 1} required /></label><button className="solid-button wide" disabled={busy}>{busy ? 'Please wait…' : authMode === 'login' ? 'Sign in' : 'Create customer account'}<ArrowUpRight size={15} /></button></form><button className="text-button" onClick={() => setAuthMode((mode) => mode === 'login' ? 'register' : 'login')}>{authMode === 'login' ? 'New to Laundry Map? Create an account' : 'Already registered? Sign in'}</button>{persona !== 'customer' && <p className="secure-note">Partner accounts are provisioned by Laundry Map operations.</p>}</div> : <div className="signed-in"><span className="signed-check"><Check size={16} /></span><span><small>SIGNED IN AS</small><strong>{user.full_name}</strong></span></div>}

          <div className="area-note"><span className="area-pin"><MapPin size={15} /></span><div><strong>Made for your neighborhood</strong><p>Serving Karu, Mararaba, and the communities in between.</p><a href="https://maps.google.com/?q=8.9912,7.6031" target="_blank" rel="noreferrer">View service area <ArrowUpRight size={13} /></a></div></div>
        </aside>
      </div>

      <footer className="footer"><a className="brand footer-brand" href="#home"><span className="brand-mark"><WashingMachine size={16} /></span><span>laundry<span className="brand-light">map</span></span></a><span>Clean clothes. Lighter days.</span><span>NASARAWA · NIGERIA</span></footer>
    </main>
  );
}

function VendorOrder({ order, onAccept, onUpdate }: { order: Order; onAccept: (id: string) => Promise<void>; onUpdate: (id: string, status: string) => Promise<void> }) {
  const [seconds, setSeconds] = useState(120);
  useEffect(() => {
    const deadline = new Date(order.vendor_response_deadline ?? (new Date(order.created_at ?? Date.now()).getTime() + 120_000)).getTime();
    const tick = () => setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [order.created_at]);
  const nextStatus = order.status === 'AT_LAUNDROMAT' ? 'PROCESSING' : order.status === 'PROCESSING' ? 'READY_FOR_DELIVERY' : null;
  return <article className="vendor-order"><div className="dispatch-top"><span className="eyebrow">ORDER {order.id.slice(0, 8).toUpperCase()}</span>{!order.vendor_accepted_at ? <span className={`timer ${seconds < 30 ? 'urgent' : ''}`}><Clock3 size={14} /> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span> : <span className="status-pill">ACCEPTED</span>}</div><h3>{order.items?.map((item) => `${item.quantity} × ${serviceLabels[item.service]}`).join(', ') || statusLabels[order.status]}</h3><p className="vendor-order-meta">{order.pickup_address ?? 'Customer pickup requested'} · {statusLabels[order.status]}</p>{order.status === 'CREATED' && !order.vendor_accepted_at && <button className="solid-button" disabled={seconds === 0} onClick={() => onAccept(order.id)}>{seconds === 0 ? 'Acceptance window closed' : 'Accept order'}<ArrowUpRight size={15} /></button>}{nextStatus && <button className="solid-button" onClick={() => onUpdate(order.id, nextStatus)}>{nextStatus === 'PROCESSING' ? 'Start care' : 'Ready for delivery'}<ArrowUpRight size={15} /></button>}</article>;
}

function DeliveryConfirm({ onConfirm }: { onConfirm: (otp: string) => Promise<void> }) {
  const [otp, setOtp] = useState('');
  return <form className="delivery-confirm" onSubmit={(event) => { event.preventDefault(); void onConfirm(otp); }}><input aria-label="Customer delivery code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" placeholder="6-digit code" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} required /><button className="solid-button" type="submit" disabled={otp.length !== 6}>Confirm delivery <Check size={15} /></button></form>;
}

function AccountPrompt({ persona, onSelect }: { persona: string; onSelect: (persona: Persona) => void }) {
  return <div className="access-prompt"><span className="service-note-icon"><LogIn size={18} /></span><h3>Sign in to your {persona} workspace.</h3><p>Partner and courier accounts are verified by our operations team.</p><button className="secondary-button" onClick={() => onSelect('customer')}>Go to account sign in <ArrowUpRight size={15} /></button></div>;
}