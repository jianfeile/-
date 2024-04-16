Page({
  data: {
    latitude: 30.658601, // 示例纬度
    longitude: 104.065837, // 示例经度
    scale: 10,
    showLocation: true,
    controls: [
      {
        id: 1,
        iconPath: '/path/to/zoom-in.png', // 放大按钮图片路径
        position: {
          left: 10,
          top: 300 - 50,
          width: 40,
          height: 40
        },
        clickable: true
      },
      {
        id: 2,
        iconPath: '/path/to/zoom-out.png', // 缩小按钮图片路径
        position: {
          left: 60,
          top: 300 - 50,
          width: 40,
          height: 40
        },
        clickable: true
      }
    ]
  },
  onLoad: function() {
    // 页面加载时执行
  },
  onControlTap: function(e) {
    let { scale } = this.data;
    if (e.controlId === 1) { // 放大
      scale += 1;
    } else if (e.controlId === 2) { // 缩小
      scale -= 1;
    }
    this.setData({
      scale: scale
    });
  },
  moveToLocation: function() {
    const map = wx.createMapContext('map');
    map.moveToLocation();
  }
});
// mapPage.js

Page({
  data: {
    markers: [
      {
        id: 1,
        latitude: 39.90469,
        longitude: 116.40717,
        title: '北京市',
        iconPath: '/images/location.png',
        width: 30,
        height: 30
      },
      {
        id: 2,
        latitude: 31.23037,
        longitude: 121.4737,
        title: '上海市',
        iconPath: '/images/location.png',
        width: 30,
        height: 30
      }
    ]
  },
  onLoad: function(options) {
    // 页面加载时的初始化工作，可根据需要调用地图 API 等进行相关设置
    // 示例中的 markers 是地图上的标记点数组，根据实际需求进行设置
  },
  onReady: function() {
    // 页面渲染完成后执行的操作，例如在这里调用地图组件的方法等
    // 示例中可以在地图渲染完成后调用方法显示标记点等
    this.showMarkers();
  },
  showMarkers: function() {
    // 在地图上显示标记点
    const mapContext = wx.createMapContext('map');
    mapContext.includePoints({
      points: this.data.markers,
      padding: [50, 50, 50, 50] // 设置地图显示区域的padding
    });
  },
  // 其他自定义方法和事件处理函数可以根据具体需求进行添加
});
