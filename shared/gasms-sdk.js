/**
 * gasms.cn SDK — 许可证验证 + 云同步 + 功能门控
 * 引入到各产品页面即可启用专业版功能
 */
(function(global) {
  'use strict';

  const API = (global.GASMS_API_URL) || 'https://0b70ce23c42b7ee8-45-135-228-212.serveousercontent.com';
  const APP = global.GASMS_APP_NAME || 'unknown';

  /**
   * 获取设备 ID（持久化，不随缓存清除变化）
   */
  function getDeviceId() {
    let id = localStorage.getItem('gasms_device_id');
    if (!id) {
      id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('gasms_device_id', id);
    }
    return id;
  }

  /**
   * SDK 状态
   */
  const state = {
    token: localStorage.getItem('gasms_token') || '',
    license: null,
    user: null,
    isPro: false,
    isEnterprise: false,
    ready: false
  };

  /**
   * 用许可证 Key 激活
   */
  async function activate(licenseKey) {
    const deviceId = getDeviceId();
    const deviceName = navigator.userAgent.split(')')[0] || 'unknown';
    try {
      const r = await fetch(API + '/api/licenses/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: licenseKey, device_id: deviceId, device_name: deviceName })
      });
      const d = await r.json();
      if (r.ok && d.valid) {
        state.license = d;
        state.isPro = d.plan === 'pro' || d.plan === 'enterprise';
        state.isEnterprise = d.plan === 'enterprise';
        localStorage.setItem('gasms_license', JSON.stringify(d));
        return d;
      }
      throw new Error(d.error || '激活失败');
    } catch(e) {
      throw e;
    }
  }

  /**
   * 检查本地缓存的许可证是否有效
   */
  function checkCachedLicense() {
    try {
      const cached = localStorage.getItem('gasms_license');
      if (!cached) return null;
      const l = JSON.parse(cached);
      if (new Date(l.expires_at) > new Date()) {
        state.license = l;
        state.isPro = l.plan === 'pro' || l.plan === 'enterprise';
        state.isEnterprise = l.plan === 'enterprise';
        return l;
      }
      localStorage.removeItem('gasms_license');
      return null;
    } catch(e) {
      return null;
    }
  }

  /**
   * 清除许可证
   */
  function deactivate() {
    localStorage.removeItem('gasms_license');
    state.license = null;
    state.isPro = false;
    state.isEnterprise = false;
  }

  /**
   * 云同步 — 上传数据
   */
  async function cloudSave(key, value) {
    if (!state.isPro) throw new Error('请升级专业版以使用云同步');
    if (!state.license) {
      const cached = checkCachedLicense();
      if (!cached) throw new Error('许可证未激活');
    }
    const r = await fetch(API + '/api/sync/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (state.token || 'anonymous') },
      body: JSON.stringify({ app: APP, data_key: key, data_value: typeof value === 'string' ? value : JSON.stringify(value) })
    });
    if (!r.ok) {
      const e = await r.json();
      throw new Error(e.error || '云同步上传失败');
    }
    return await r.json();
  }

  /**
   * 云同步 — 下载数据
   */
  async function cloudLoad(key) {
    if (!state.isPro) throw new Error('请升级专业版以使用云同步');
    const r = await fetch(API + '/api/sync/' + APP + '/' + key, {
      headers: { 'Authorization': 'Bearer ' + (state.token || 'anonymous') }
    });
    if (!r.ok) throw new Error('云同步下载失败');
    return await r.json();
  }

  /**
   * 云同步 — 获取所有数据（恢复用）
   */
  async function cloudList() {
    if (!state.isPro) throw new Error('请升级专业版以使用云同步');
    const r = await fetch(API + '/api/sync/' + APP, {
      headers: { 'Authorization': 'Bearer ' + (state.token || 'anonymous') }
    });
    if (!r.ok) throw new Error('云同步列表获取失败');
    return await r.json();
  }

  // 尝试加载缓存许可证
  checkCachedLicense();

  // 导出
  global.GasmsSDK = {
    state,
    activate,
    deactivate,
    checkCachedLicense,
    cloudSave,
    cloudLoad,
    cloudList,
    getDeviceId,
    API
  };

})(window);
