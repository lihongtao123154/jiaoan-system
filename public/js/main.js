// ====== 《体育与健康》课程教学资源库 - 前端公共脚本 ======

// 文件大小格式化
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// 日期格式化
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return year + '-' + month + '-' + day + ' ' + hour + ':' + min;
}

// 页面加载完成后
document.addEventListener('DOMContentLoaded', function() {
  // 自动消失的提示消息
  document.querySelectorAll('.alert').forEach(function(el) {
    if (el.classList.contains('alert-success')) {
      setTimeout(function() {
        el.style.transition = 'opacity 0.5s';
        el.style.opacity = '0';
        setTimeout(function() { el.remove(); }, 500);
      }, 5000);
    }
  });

  // 导航栏菜单点击外部关闭
  document.addEventListener('click', function(e) {
    const menu = document.querySelector('.nav-menu');
    const toggle = document.querySelector('.nav-toggle');
    if (menu && toggle && menu.classList.contains('show')) {
      if (!menu.contains(e.target) && !toggle.contains(e.target)) {
        menu.classList.remove('show');
      }
    }
  });
});
