// pages/index/index.js
Page({
  // 页面的初始数据
  data: {},

  // 生命周期函数--监听页面加载
  onLoad: function (options) {},

  // 导航到寻找厕所页面
  navigateToFindToilet: function() {
    wx.navigateTo({
      url: '/pages/findToilet/findToilet' // 确保路径正确
    });
  }
});
// findToilet.js
Page({
  data: {
    latitude: 39.90886, // 目标纬度，示例为北京天安门的纬度
    longitude: 116.39739 // 目标经度，示例为北京天安门的经度
  },

  onLoad: function() {
    // 页面加载时获取用户的位置信息
    this.getUserLocation();
  },

  getUserLocation: function() {
    let vm = this;
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.userLocation']) {
          wx.getLocation({
            type: 'wgs84',
            success(res) {
              console.log(res.latitude, res.longitude);
              // 这里可以保存用户的当前位置，如果需要
            }
          })
        } else {
          wx.authorize({
            scope: 'scope.userLocation',
            success() {
              wx.getLocation({
                type: 'wgs84',
                success(res) {
                  console.log(res.latitude, res.longitude);
                  // 这里可以保存用户的当前位置，如果需要
                }
              })
            }
          })
        }
      }
    })
  },

  navigateToLocation: function() {
    // 使用 wx.openLocation 打开内置地图，导航到指定位置
    wx.openLocation({
      latitude: parseFloat(this.data.latitude),
      longitude: parseFloat(this.data.longitude),
      scale: 18,
      name: "目的地名称", // 如天安门
      address: "目的地详细地址" // 如北京市东城区东长安街
    })
  }
});
// pages/findToilet/findToilet.js
Page({
  onLoad: function() {
    // 页面加载时获取用户位置
    this.getUserLocation();
  },
  getUserLocation: function() {
    wx.getLocation({
      type: 'wgs84',
      success(res) {
        console.log(res.latitude, res.longitude);
        // 你可以在这里做一些位置相关的处理
      },
      fail(err) {
        console.error("获取位置失败", err);
        // 这里可以添加用户拒绝地理位置权限后的处理逻辑
      }
    });
  }
});
