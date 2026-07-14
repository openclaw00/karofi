(function () {
  const cartKey = 'karofi-store-cart-v1';
  const ordersKey = 'karofi-store-orders-v1';

  const products = {
    'sa9-premium': {
      id: 'sa9-premium',
      name: 'Karofi SA9 PREMIUM',
      fullName: 'Máy lọc nước nóng lạnh Hydro-ion Kiềm Karofi SA9 PREMIUM',
      price: 49900000,
      image: 'assets/karofi-sa9-premium.png',
      detailUrl: 'product.html?id=sa9-premium'
    },
    'diamond-sa66': {
      id: 'diamond-sa66',
      name: 'Karofi DIAMOND SA66',
      fullName: 'Máy lọc nước nóng lạnh Hydro-ion kiềm Karofi DIAMOND SA66',
      price: 59000000,
      image: 'assets/karofi-diamond-sa66.png',
      detailUrl: 'sa66.html'
    },
    'kae-s688': {
      id: 'kae-s688',
      name: 'Karofi KAE-S688',
      fullName: 'Máy lọc nước Hydro-ion kiềm nóng lạnh Karofi KAE-S688',
      price: 21990000,
      image: 'assets/karofi-kae-s688.png',
      detailUrl: 'product.html?id=kae-s688'
    },
    'kae-s695': {
      id: 'kae-s695',
      name: 'Karofi KAE-S695',
      fullName: 'Máy lọc nước nóng lạnh Hydro-ion kiềm Karofi KAE-S695',
      price: 31890000,
      image: 'assets/karofi-kae-s695.png',
      detailUrl: 'product.html?id=kae-s695'
    },
    'kae-s88-promax': {
      id: 'kae-s88-promax',
      name: 'Karofi KAE-S88 PROMAX',
      fullName: 'Máy lọc nước nóng lạnh Hydro-ion kiềm Karofi KAE-S88 PROMAX',
      price: 39490000,
      image: 'assets/karofi-kae-s88-promax.png',
      detailUrl: 'product.html?id=kae-s88-promax'
    }
  };

  const formatMoney = (amount) => new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0
  }).format(amount);

  const readJson = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch (_) {
      return fallback;
    }
  };

  const writeJson = (key, value) => {
    localStorage.setItem(key, JSON.stringify(value));
  };

  const getCart = () => readJson(cartKey, []);
  const saveCart = (cart) => {
    writeJson(cartKey, cart);
    updateCartBadges();
  };
  const getOrders = () => readJson(ordersKey, []);
  const saveOrders = (orders) => writeJson(ordersKey, orders);
  const getProduct = (id) => products[id];

  const getCartLines = () => getCart()
    .map((item) => ({ ...item, product: getProduct(item.id) }))
    .filter((item) => item.product);

  const getCartTotal = () => getCartLines().reduce((sum, item) => {
    return sum + item.product.price * item.quantity;
  }, 0);

  const getCartCount = () => getCart().reduce((sum, item) => sum + item.quantity, 0);

  const updateCartBadges = () => {
    document.querySelectorAll('[data-cart-count]').forEach((badge) => {
      badge.textContent = String(getCartCount());
    });
  };

  const showToast = (message) => {
    const toast = document.createElement('div');
    toast.className = 'karofi-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.classList.add('is-visible'), 20);
    window.setTimeout(() => {
      toast.classList.remove('is-visible');
      window.setTimeout(() => toast.remove(), 220);
    }, 2100);
  };

  const addToCart = (id, quantity = 1) => {
    const product = getProduct(id);
    if (!product) return;
    const cart = getCart();
    const existing = cart.find((item) => item.id === id);
    if (existing) existing.quantity += quantity;
    else cart.push({ id, quantity });
    saveCart(cart);
    showToast(`${product.name} đã được thêm vào giỏ hàng`);
  };

  const setQuantity = (id, quantity) => {
    const nextQuantity = Math.max(0, Number(quantity) || 0);
    const cart = getCart().reduce((items, item) => {
      if (item.id === id) {
        if (nextQuantity > 0) items.push({ ...item, quantity: nextQuantity });
      } else {
        items.push(item);
      }
      return items;
    }, []);
    saveCart(cart);
  };

  const clearCart = () => saveCart([]);

  const buildOrderPayload = (customer) => {
    const lines = getCartLines();
    if (!lines.length) throw new Error('Giỏ hàng đang trống.');

    return {
      customer,
      items: lines.map((line) => ({
        id: line.id,
        name: line.product.fullName,
        price: line.product.price,
        quantity: line.quantity
      })),
      total: getCartTotal()
    };
  };

  const submitOrderToServer = async (payload) => {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Không gửi được đơn hàng.');
    return result;
  };

  const fetchServerOrders = async (token = '') => {
    const headers = { accept: 'application/json' };
    if (token) headers['x-orders-token'] = token;
    const response = await fetch('/api/orders', { headers });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Không tải được danh sách đơn hàng.');
    return Array.isArray(result.orders) ? result.orders : [];
  };

  const placeOrder = (customer) => {
    const payload = buildOrderPayload(customer);

    const order = {
      id: `KRF-${Date.now().toString(36).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      status: 'Chờ xử lý',
      ...payload
    };

    const orders = getOrders();
    orders.unshift(order);
    saveOrders(orders);
    clearCart();
    sessionStorage.setItem('karofi-last-order-id', order.id);
    return order;
  };

  const bindStoreButtons = () => {
    document.querySelectorAll('[data-add-to-cart]').forEach((button) => {
      button.addEventListener('click', () => addToCart(button.dataset.addToCart));
    });

    document.querySelectorAll('[data-buy-now]').forEach((button) => {
      button.addEventListener('click', () => {
        addToCart(button.dataset.buyNow);
        window.location.href = 'checkout.html';
      });
    });
  };

  const cartApi = {
    products,
    formatMoney,
    getCart,
    getCartLines,
    getCartCount,
    getCartTotal,
    getOrders,
    fetchServerOrders,
    addToCart,
    setQuantity,
    clearCart,
    buildOrderPayload,
    submitOrderToServer,
    placeOrder,
    updateCartBadges,
    bindStoreButtons
  };

  window.KarofiStore = cartApi;
  document.addEventListener('DOMContentLoaded', () => {
    updateCartBadges();
    bindStoreButtons();
  });
})();
